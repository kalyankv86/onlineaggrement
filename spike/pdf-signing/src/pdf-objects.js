'use strict';
/**
 * Minimal PDF structural parser — only what the incremental-update signer needs:
 * the xref chain, an object-number -> byte-offset map, the trailer dictionary,
 * and raw object bodies.
 *
 * Deliberately narrow. It handles the classic cross-reference *table* produced by
 * pdf-lib when saved with `useObjectStreams: false`, plus the /Prev chain that our
 * own incremental updates create. It does not handle cross-reference streams,
 * because we control the generator and never emit them.
 */

/** Locate the byte offset recorded by the final `startxref` keyword. */
function findStartXref(buf) {
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  const idx = tail.lastIndexOf('startxref');
  if (idx === -1) throw new Error('startxref not found');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new Error('startxref value unparseable');
  return parseInt(m[1], 10);
}

/**
 * Parse one classic xref section at `offset`.
 * Returns { entries: Map<objNum, offset>, trailer: string, prev: number|null }.
 */
function parseXrefSection(buf, offset) {
  const s = buf.toString('latin1', offset, Math.min(buf.length, offset + 1024 * 1024));
  if (!s.startsWith('xref')) {
    throw new Error(`expected classic xref table at ${offset}, found: ${s.slice(0, 32)}`);
  }

  const entries = new Map();
  let pos = 4; // past 'xref'
  // Subsection headers: "<start> <count>" then <count> fixed 20-byte entries.
  for (;;) {
    const header = /^\s*(\d+)\s+(\d+)\s*[\r\n]+/.exec(s.slice(pos));
    if (!header) break;
    pos += header[0].length;
    const start = parseInt(header[1], 10);
    const count = parseInt(header[2], 10);
    for (let i = 0; i < count; i += 1) {
      const raw = s.slice(pos, pos + 20);
      const e = /^(\d{10})\s(\d{5})\s([nf])/.exec(raw);
      if (!e) throw new Error(`malformed xref entry at subsection ${start}+${i}`);
      if (e[3] === 'n') entries.set(start + i, parseInt(e[1], 10));
      pos += 20;
    }
  }

  const tIdx = s.indexOf('trailer', pos);
  if (tIdx === -1) throw new Error('trailer not found after xref table');
  const dictStart = s.indexOf('<<', tIdx);
  const dictEnd = findDictEnd(s, dictStart);
  const trailer = s.slice(dictStart, dictEnd);
  const prevMatch = /\/Prev\s+(\d+)/.exec(trailer);

  return { entries, trailer, prev: prevMatch ? parseInt(prevMatch[1], 10) : null };
}

/** Given the index of `<<`, return the index just past its matching `>>`. */
function findDictEnd(s, start) {
  let depth = 0;
  for (let i = start; i < s.length - 1; i += 1) {
    if (s[i] === '<' && s[i + 1] === '<') { depth += 1; i += 1; }
    else if (s[i] === '>' && s[i + 1] === '>') { depth -= 1; i += 1; if (depth === 0) return i + 1; }
  }
  throw new Error('unterminated dictionary');
}

/**
 * Walk the whole xref chain, newest section first. Because we walk newest-first
 * and never overwrite an already-seen object number, the resulting map holds the
 * *current* offset for every object — which is exactly the incremental-update
 * resolution rule.
 */
function parseDocument(buf) {
  const offsets = new Map();
  let sectionOffset = findStartXref(buf);
  let newestTrailer = null;
  const seen = new Set();

  while (sectionOffset !== null && sectionOffset !== undefined) {
    if (seen.has(sectionOffset)) throw new Error('cyclic /Prev chain');
    seen.add(sectionOffset);
    const section = parseXrefSection(buf, sectionOffset);
    if (newestTrailer === null) newestTrailer = section.trailer;
    for (const [num, off] of section.entries) {
      if (!offsets.has(num)) offsets.set(num, off);
    }
    sectionOffset = section.prev;
  }

  const sizeMatch = /\/Size\s+(\d+)/.exec(newestTrailer);
  const rootMatch = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(newestTrailer);
  if (!sizeMatch) throw new Error('trailer has no /Size');
  if (!rootMatch) throw new Error('trailer has no /Root');

  return {
    offsets,
    trailer: newestTrailer,
    size: parseInt(sizeMatch[1], 10),
    rootRef: { num: parseInt(rootMatch[1], 10), gen: parseInt(rootMatch[2], 10) },
  };
}

/** Raw body of an indirect object: the text between `N G obj` and `endobj`. */
function readObject(buf, offsets, num) {
  const offset = offsets.get(num);
  if (offset === undefined) throw new Error(`object ${num} not in xref`);
  const s = buf.toString('latin1', offset, Math.min(buf.length, offset + 512 * 1024));
  const head = new RegExp(`^${num}\\s+(\\d+)\\s+obj`).exec(s);
  if (!head) throw new Error(`object ${num} header not found at offset ${offset}`);
  const end = s.indexOf('endobj', head[0].length);
  if (end === -1) throw new Error(`object ${num} has no endobj`);
  return { gen: parseInt(head[1], 10), body: s.slice(head[0].length, end).trim() };
}

/**
 * Find the object number of the AcroForm signature field whose /T equals `name`.
 * Scans every object in the xref map rather than walking /AcroForm /Fields, which
 * keeps us independent of how the generator nested the field tree.
 */
function findFieldByName(buf, offsets, name) {
  const needle = `/T (${name})`;
  for (const num of offsets.keys()) {
    let obj;
    try { obj = readObject(buf, offsets, num); } catch { continue; }
    if (obj.body.includes(needle) && obj.body.includes('/FT /Sig')) {
      return { num, gen: obj.gen, body: obj.body };
    }
  }
  throw new Error(`signature field "${name}" not found`);
}

/** Find an object by a distinguishing substring (used to locate the base font). */
function findObjectContaining(buf, offsets, needle) {
  for (const num of offsets.keys()) {
    let obj;
    try { obj = readObject(buf, offsets, num); } catch { continue; }
    if (obj.body.includes(needle)) return { num, gen: obj.gen, body: obj.body };
  }
  return null;
}

/**
 * Every `/ByteRange [a b c d]` in the file, with the byte offset of the `<` that
 * opens the corresponding /Contents hex string. Used by the verifier.
 */
function findSignatures(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const contentsTag = s.indexOf('/Contents', m.index);
    if (contentsTag === -1) continue;
    const open = s.indexOf('<', contentsTag);
    const close = s.indexOf('>', open);
    out.push({
      byteRange: [
        parseInt(m[1], 10), parseInt(m[2], 10),
        parseInt(m[3], 10), parseInt(m[4], 10),
      ],
      contentsStart: open,
      contentsEnd: close + 1,
      hex: s.slice(open + 1, close),
    });
  }
  return out;
}

module.exports = {
  findStartXref,
  parseXrefSection,
  parseDocument,
  readObject,
  findFieldByName,
  findObjectContaining,
  findSignatures,
  findDictEnd,
};
