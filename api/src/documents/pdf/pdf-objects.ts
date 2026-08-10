/**
 * Minimal PDF structural parser — only what the incremental-update signer needs.
 * Ported from spike/pdf-signing after the Phase 2 gate passed; see that README for
 * the reasoning and the measured results.
 *
 * Handles the classic cross-reference *table* our own generator emits (pdf-lib
 * saved with `useObjectStreams: false`) plus the /Prev chain our incremental
 * updates create. Cross-reference streams are intentionally unsupported: we
 * control the generator, and failing loudly on an unexpected structure is safer
 * than guessing at one.
 */

export interface PdfDocumentIndex {
  offsets: Map<number, number>;
  trailer: string;
  size: number;
  rootRef: { num: number; gen: number };
}

export interface PdfObject {
  num: number;
  gen: number;
  body: string;
}

export interface PdfSignatureSlot {
  byteRange: [number, number, number, number];
  contentsStart: number;
  contentsEnd: number;
  hex: string;
}

export function findStartXref(buf: Buffer): number {
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  const idx = tail.lastIndexOf('startxref');
  if (idx === -1) throw new Error('startxref not found');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new Error('startxref value unparseable');
  return parseInt(m[1], 10);
}

/** Given the index of `<<`, return the index just past its matching `>>`. */
export function findDictEnd(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length - 1; i += 1) {
    if (s[i] === '<' && s[i + 1] === '<') {
      depth += 1;
      i += 1;
    } else if (s[i] === '>' && s[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unterminated dictionary');
}

function parseXrefSection(
  buf: Buffer,
  offset: number,
): { entries: Map<number, number>; trailer: string; prev: number | null } {
  const s = buf.toString('latin1', offset, Math.min(buf.length, offset + 1024 * 1024));
  if (!s.startsWith('xref')) {
    throw new Error(
      `expected a classic xref table at ${offset} but found "${s.slice(0, 24)}" — ` +
        'cross-reference streams are not supported by this signer',
    );
  }

  const entries = new Map<number, number>();
  let pos = 4;
  for (;;) {
    const header = /^\s*(\d+)\s+(\d+)\s*[\r\n]+/.exec(s.slice(pos));
    if (!header) break;
    pos += header[0].length;
    const start = parseInt(header[1], 10);
    const count = parseInt(header[2], 10);
    for (let i = 0; i < count; i += 1) {
      const e = /^(\d{10})\s(\d{5})\s([nf])/.exec(s.slice(pos, pos + 20));
      if (!e) throw new Error(`malformed xref entry at subsection ${start}+${i}`);
      if (e[3] === 'n') entries.set(start + i, parseInt(e[1], 10));
      pos += 20;
    }
  }

  const tIdx = s.indexOf('trailer', pos);
  if (tIdx === -1) throw new Error('trailer not found after xref table');
  const dictStart = s.indexOf('<<', tIdx);
  const trailer = s.slice(dictStart, findDictEnd(s, dictStart));
  const prevMatch = /\/Prev\s+(\d+)/.exec(trailer);
  return { entries, trailer, prev: prevMatch ? parseInt(prevMatch[1], 10) : null };
}

/**
 * Walk the whole xref chain, newest section first, never overwriting an
 * already-seen object number. That ordering *is* the incremental-update
 * resolution rule: the most recent revision of an object wins.
 */
export function parseDocument(buf: Buffer): PdfDocumentIndex {
  const offsets = new Map<number, number>();
  let sectionOffset: number | null = findStartXref(buf);
  let newestTrailer: string | null = null;
  const seen = new Set<number>();

  while (sectionOffset !== null) {
    if (seen.has(sectionOffset)) throw new Error('cyclic /Prev chain');
    seen.add(sectionOffset);
    const section = parseXrefSection(buf, sectionOffset);
    if (newestTrailer === null) newestTrailer = section.trailer;
    for (const [num, off] of section.entries) if (!offsets.has(num)) offsets.set(num, off);
    sectionOffset = section.prev;
  }

  const trailer = newestTrailer as string;
  const sizeMatch = /\/Size\s+(\d+)/.exec(trailer);
  const rootMatch = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailer);
  if (!sizeMatch) throw new Error('trailer has no /Size');
  if (!rootMatch) throw new Error('trailer has no /Root');

  return {
    offsets,
    trailer,
    size: parseInt(sizeMatch[1], 10),
    rootRef: { num: parseInt(rootMatch[1], 10), gen: parseInt(rootMatch[2], 10) },
  };
}

export function readObject(buf: Buffer, offsets: Map<number, number>, num: number): PdfObject {
  const offset = offsets.get(num);
  if (offset === undefined) throw new Error(`object ${num} not in xref`);
  const s = buf.toString('latin1', offset, Math.min(buf.length, offset + 512 * 1024));
  const head = new RegExp(`^${num}\\s+(\\d+)\\s+obj`).exec(s);
  if (!head) throw new Error(`object ${num} header not found at offset ${offset}`);
  const end = s.indexOf('endobj', head[0].length);
  if (end === -1) throw new Error(`object ${num} has no endobj`);
  return { num, gen: parseInt(head[1], 10), body: s.slice(head[0].length, end).trim() };
}

/**
 * Locate a signature field by its /T. Scans every indexed object rather than
 * walking /AcroForm /Fields, which keeps the signer independent of how the
 * generator nested the field tree.
 */
export function findFieldByName(
  buf: Buffer,
  offsets: Map<number, number>,
  name: string,
): PdfObject {
  const needle = `/T (${name})`;
  for (const num of offsets.keys()) {
    let obj: PdfObject;
    try {
      obj = readObject(buf, offsets, num);
    } catch {
      continue;
    }
    if (obj.body.includes(needle) && obj.body.includes('/FT /Sig')) return obj;
  }
  throw new Error(`signature field "${name}" not found`);
}

export function findObjectContaining(
  buf: Buffer,
  offsets: Map<number, number>,
  needle: string,
): PdfObject | null {
  for (const num of offsets.keys()) {
    let obj: PdfObject;
    try {
      obj = readObject(buf, offsets, num);
    } catch {
      continue;
    }
    if (obj.body.includes(needle)) return obj;
  }
  return null;
}

/** Every /ByteRange in the file with the byte span of its /Contents hex string. */
export function findSignatures(buf: Buffer): PdfSignatureSlot[] {
  const s = buf.toString('latin1');
  const out: PdfSignatureSlot[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const contentsTag = s.indexOf('/Contents', m.index);
    if (contentsTag === -1) continue;
    const open = s.indexOf('<', contentsTag);
    const close = s.indexOf('>', open);
    out.push({
      byteRange: [
        parseInt(m[1], 10),
        parseInt(m[2], 10),
        parseInt(m[3], 10),
        parseInt(m[4], 10),
      ],
      contentsStart: open,
      contentsEnd: close + 1,
      hex: s.slice(open + 1, close),
    });
  }
  return out;
}
