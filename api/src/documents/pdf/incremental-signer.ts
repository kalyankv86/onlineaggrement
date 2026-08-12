/**
 * PDF incremental-update writer — the mechanism DEC-001 turns on, validated by
 * the Phase 2 gate (spike/pdf-signing, AC-10).
 *
 * Every mutation after generation *appends* new revisions of objects plus a fresh
 * cross-reference section chained by /Prev. Bytes already in the file are never
 * touched, so a ByteRange signed in an earlier revision still digests to the same
 * value: signature N+1 cannot invalidate signatures 1..N.
 *
 * Consequence, and the reason this file exists at all: after `preparer.ts` has run,
 * NOTHING else may write the byte stream. Re-rendering with Chromium or re-saving
 * with pdf-lib rewrites the whole file and destroys every prior signature.
 */

import {
  parseDocument,
  findFieldByName,
  findStartXref,
  findSignatures,
  PdfDocumentIndex,
} from './pdf-objects';

export const DEFAULT_SIGNATURE_RESERVED_BYTES = 8192;

/** Produces detached PKCS#7 DER over the bytes covered by the ByteRange. */
export type DetachedSigner = (content: Buffer) => Promise<Buffer> | Buffer;

export interface SignatureAppearance {
  name: string;
  reason: string;
  location: string;
  signedAt?: Date;
}

export interface AppendSignatureResult {
  buffer: Buffer;
  byteRange: [number, number, number, number];
  signatureBytes: number;
  sigObjectNumber: number;
  /** The digest actually signed — stored as esign_transactions.byte_range_digest. */
  signedContent: Buffer;
}

const pad10 = (n: number): string => String(n).padStart(10, '0');
const escapePdfText = (s: string): string => String(s).replace(/([\\()])/g, '\\$1');

export function pdfDate(d: Date = new Date()): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.trunc(tz / 60))}'${p(tz % 60)}'`
  );
}

interface RevisionObject {
  num: number;
  gen: number;
  content: string;
}

/** Append a revision plus a new xref section chained to the existing one. */
export function appendRevision(
  buf: Buffer,
  doc: PdfDocumentIndex,
  objects: RevisionObject[],
): Buffer {
  const prevStartXref = findStartXref(buf);
  const idMatch = /\/ID\s*\[\s*<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>\s*\]/.exec(doc.trailer);
  const idPart = idMatch ? ` /ID [<${idMatch[1]}> <${idMatch[2]}>]` : '';

  const sorted = [...objects].sort((a, b) => a.num - b.num);
  const newSize = Math.max(doc.size, sorted[sorted.length - 1].num + 1);

  let body = '\n';
  const offsets = new Map<number, number>();
  for (const o of sorted) {
    offsets.set(o.num, buf.length + body.length);
    body += `${o.num} ${o.gen} obj\n${o.content}\nendobj\n`;
  }

  const xrefOffset = buf.length + body.length;

  // One subsection per object — they are not contiguous — ascending, plus the head
  // free entry so the free list stays well formed. Each entry is exactly 20 bytes.
  let xref = 'xref\n0 1\n0000000000 65535 f \n';
  for (const o of sorted) {
    xref += `${o.num} 1\n${pad10(offsets.get(o.num)!)} ${String(o.gen).padStart(5, '0')} n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${newSize} /Root ${doc.rootRef.num} ${doc.rootRef.gen} R` +
    `${idPart} /Prev ${prevStartXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([buf, Buffer.from(body + xref + trailer, 'latin1')]);
}

function injectIntoDict(dictBody: string, extra: string): string {
  const close = dictBody.lastIndexOf('>>');
  if (close === -1) throw new Error('object body is not a dictionary');
  return `${dictBody.slice(0, close).trimEnd()} ${extra} ${dictBody.slice(close)}`;
}

export interface PreparedSignatureSlot {
  /** The document with the signature revision appended and /Contents still empty. */
  buffer: Buffer;
  byteRange: [number, number, number, number];
  /** Byte offset of the `<` that opens the reserved /Contents gap. */
  gapStart: number;
  hexLength: number;
  /** Exactly the bytes the ESP must sign. */
  signedContent: Buffer;
  sigObjectNumber: number;
}

/**
 * Phase 1 of signing: append the signature revision with an empty /Contents gap
 * and compute the ByteRange digest.
 *
 * Signing is two-phase because a real Aadhaar eSign ceremony is not a function
 * call — the signer leaves for the ESP, authenticates with an OTP, and the result
 * arrives later on a webhook. The digest produced here is the only thing about the
 * document that leaves GTIDS (DEC-002, hash-based model); the bytes stay put until
 * `embedSignature` fills the gap.
 */
export function prepareSignatureSlot(
  buf: Buffer,
  opts: SignatureAppearance & { fieldName: string; reservedBytes?: number },
): PreparedSignatureSlot {
  const doc = parseDocument(buf);
  const field = findFieldByName(buf, doc.offsets, opts.fieldName);

  if (/\/V\s+\d+\s+\d+\s+R/.test(field.body)) {
    throw new Error(`signature field "${opts.fieldName}" is already signed`);
  }

  const reserved = opts.reservedBytes ?? DEFAULT_SIGNATURE_RESERVED_BYTES;
  const hexLen = reserved * 2;
  const sigNum = doc.size;
  const byteRangePlaceholder = '[0 0000000000 0000000000 0000000000]';

  const sigObj =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached` +
    ` /Name (${escapePdfText(opts.name)}) /Reason (${escapePdfText(opts.reason)})` +
    ` /Location (${escapePdfText(opts.location)}) /M (${pdfDate(opts.signedAt)})` +
    ` /ByteRange ${byteRangePlaceholder} /Contents <${'0'.repeat(hexLen)}> >>`;

  const out = appendRevision(buf, doc, [
    { num: sigNum, gen: 0, content: sigObj },
    { num: field.num, gen: field.gen, content: injectIntoDict(field.body, `/V ${sigNum} 0 R`) },
  ]);

  const s = out.toString('latin1');
  const brPos = s.indexOf(`/ByteRange ${byteRangePlaceholder}`, buf.length);
  if (brPos === -1) throw new Error('ByteRange placeholder lost');
  const gapStart = s.indexOf('<', s.indexOf('/Contents', brPos));
  const gapEnd = s.indexOf('>', gapStart);
  const gapLen = gapEnd + 1 - gapStart;

  const byteRange: [number, number, number, number] = [
    0,
    gapStart,
    gapStart + gapLen,
    out.length - (gapStart + gapLen),
  ];

  // Patch the ByteRange *before* digesting — those bytes are themselves inside the
  // signed range. Fixed-width zero padding keeps the patch length-neutral.
  const filled = `/ByteRange [0 ${pad10(byteRange[1])} ${pad10(byteRange[2])} ${pad10(byteRange[3])}]`;
  if (filled.length !== `/ByteRange ${byteRangePlaceholder}`.length) {
    throw new Error('ByteRange patch would change file length');
  }
  out.write(filled, brPos, 'latin1');

  return {
    buffer: out,
    byteRange,
    gapStart,
    hexLength: hexLen,
    signedContent: Buffer.concat([
      out.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      out.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]),
    sigObjectNumber: sigNum,
  };
}

/**
 * Phase 2: write the PKCS#7 the ESP returned into the reserved gap.
 *
 * The gap is a fixed-length region, so filling it changes no offset and disturbs
 * no earlier signature. Padding is zeroes, which sit outside the DER and are
 * ignored by readers.
 */
export function embedSignature(slot: PreparedSignatureSlot, der: Buffer): Buffer {
  const hex = der.toString('hex').toUpperCase();
  if (hex.length > slot.hexLength) {
    throw new Error(
      `signature is ${der.length} bytes but only ${slot.hexLength / 2} are reserved — ` +
        'raise PDF_SIGNATURE_RESERVED_BYTES',
    );
  }
  const out = Buffer.from(slot.buffer);
  out.write(hex.padEnd(slot.hexLength, '0'), slot.gapStart + 1, 'latin1');
  return out;
}

/**
 * Rebuild a prepared slot from parked bytes.
 *
 * The ceremony that begins on one API instance can finish on another, so the slot
 * is reconstructed from the document rather than held in process memory. The
 * unfilled slot is identifiable without ambiguity: it is the only signature whose
 * /Contents gap is still all zeroes.
 */
export function reopenSignatureSlot(pending: Buffer): PreparedSignatureSlot {
  const slots = findSignatures(pending);
  const empty = slots.filter((s) => /^0*$/.test(s.hex));
  if (empty.length === 0) throw new Error('parked document has no unfilled signature slot');
  if (empty.length > 1) throw new Error('parked document has more than one unfilled signature slot');

  const slot = empty[0];
  if (slot.byteRange[1] !== slot.contentsStart || slot.byteRange[2] !== slot.contentsEnd) {
    throw new Error('parked document ByteRange does not match its /Contents gap');
  }

  return {
    buffer: pending,
    byteRange: slot.byteRange,
    gapStart: slot.contentsStart,
    hexLength: slot.contentsEnd - slot.contentsStart - 2,
    signedContent: Buffer.concat([
      pending.subarray(slot.byteRange[0], slot.byteRange[0] + slot.byteRange[1]),
      pending.subarray(slot.byteRange[2], slot.byteRange[2] + slot.byteRange[3]),
    ]),
    sigObjectNumber: -1, // not needed once the revision is written
  };
}

/**
 * Both phases at once, for callers that can produce the signature inline — the
 * mock provider, and the Phase 2 gate spike.
 */
export async function appendSignature(
  buf: Buffer,
  opts: SignatureAppearance & {
    fieldName: string;
    sign: DetachedSigner;
    reservedBytes?: number;
  },
): Promise<AppendSignatureResult> {
  const slot = prepareSignatureSlot(buf, opts);
  const der = await opts.sign(slot.signedContent);
  return {
    buffer: embedSignature(slot, der),
    byteRange: slot.byteRange,
    signatureBytes: der.length,
    sigObjectNumber: slot.sigObjectNumber,
    signedContent: slot.signedContent,
  };
}
