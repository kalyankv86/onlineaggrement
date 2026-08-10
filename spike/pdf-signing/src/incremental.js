'use strict';
/**
 * PDF incremental-update writer — the mechanism DEC-001 turns on.
 *
 * Every mutation after generation is written by *appending* new revisions of
 * objects plus a fresh cross-reference section whose /Prev points at the previous
 * one. Bytes already in the file are never touched, so a ByteRange signed in an
 * earlier revision still digests to the same value: signature N+1 cannot
 * invalidate signatures 1..N.
 *
 * This is why the pipeline cannot simply re-render with Chromium or re-save with
 * pdf-lib — both rewrite the whole file and would break every prior signature.
 */

const { parseDocument, readObject, findFieldByName } = require('./pdf-objects');
const { signDetached } = require('./pkcs7');

/** Reserved /Contents gap. RSA-2048 detached CMS with one cert is ~1.5-2 KB. */
const SIGNATURE_RESERVED_BYTES = 8192;

const pad10 = (n) => String(n).padStart(10, '0');
const escapePdfText = (s) => String(s).replace(/([\\()])/g, '\\$1');

/** PDF date string, e.g. D:20260809103000+05'30' */
function pdfDate(d = new Date()) {
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.trunc(tz / 60))}'${p(tz % 60)}'`
  );
}

/**
 * Append a revision containing `objects` ([{ num, gen, content }]) and a new xref
 * section chained to the existing one. `content` is the full object body,
 * including any stream. Returns the new buffer.
 */
function appendRevision(buf, doc, objects) {
  const prevStartXref = require('./pdf-objects').findStartXref(buf);
  const idMatch = /\/ID\s*\[\s*<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>\s*\]/.exec(doc.trailer);
  const idPart = idMatch ? ` /ID [<${idMatch[1]}> <${idMatch[2]}>]` : '';

  const sorted = [...objects].sort((a, b) => a.num - b.num);
  const maxNum = sorted[sorted.length - 1].num;
  const newSize = Math.max(doc.size, maxNum + 1);

  // Lay the objects out to learn their absolute offsets.
  let body = '\n';
  const offsets = new Map();
  for (const o of sorted) {
    offsets.set(o.num, buf.length + body.length);
    body += `${o.num} ${o.gen} obj\n${o.content}\nendobj\n`;
  }

  const xrefOffset = buf.length + body.length;

  // One subsection per object (they are not contiguous), ascending, plus the
  // head free entry so the free-list remains well formed.
  let xref = 'xref\n0 1\n0000000000 65535 f \n';
  for (const o of sorted) {
    xref += `${o.num} 1\n${pad10(offsets.get(o.num))} ${String(o.gen).padStart(5, '0')} n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${newSize} /Root ${doc.rootRef.num} ${doc.rootRef.gen} R` +
    `${idPart} /Prev ${prevStartXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([buf, Buffer.from(body + xref + trailer, 'latin1')]);
}

/** Insert `extra` immediately before a dictionary's final `>>`. */
function injectIntoDict(dictBody, extra) {
  const close = dictBody.lastIndexOf('>>');
  if (close === -1) throw new Error('object body is not a dictionary');
  return `${dictBody.slice(0, close).trimEnd()} ${extra} ${dictBody.slice(close)}`;
}

/**
 * Apply a digital signature to one reserved field as an incremental update.
 *
 * `sign` is `(contentBuffer) => Buffer` returning detached PKCS#7 DER. In
 * production this delegates to the eSign provider adapter (DEC-002 hash-based
 * model); the content digest is all that leaves GTIDS.
 */
function appendSignature(buf, { fieldName, sign, name, reason, location, signedAt }) {
  const doc = parseDocument(buf);
  const field = findFieldByName(buf, doc.offsets, fieldName);

  if (/\/V\s+\d+\s+\d+\s+R/.test(field.body)) {
    throw new Error(`signature field "${fieldName}" is already signed`);
  }

  const sigNum = doc.size;
  const hexLen = SIGNATURE_RESERVED_BYTES * 2;
  const byteRangePlaceholder = '[0 0000000000 0000000000 0000000000]';

  const sigObj =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached` +
    ` /Name (${escapePdfText(name)}) /Reason (${escapePdfText(reason)})` +
    ` /Location (${escapePdfText(location)}) /M (${pdfDate(signedAt)})` +
    ` /ByteRange ${byteRangePlaceholder} /Contents <${'0'.repeat(hexLen)}> >>`;

  const updatedField = injectIntoDict(field.body, `/V ${sigNum} 0 R`);

  let out = appendRevision(buf, doc, [
    { num: sigNum, gen: 0, content: sigObj },
    { num: field.num, gen: field.gen, content: updatedField },
  ]);

  // Locate the gap we just wrote (it is the last one in the file).
  const s = out.toString('latin1');
  const brPos = s.indexOf(`/ByteRange ${byteRangePlaceholder}`, buf.length);
  if (brPos === -1) throw new Error('ByteRange placeholder lost');
  const contentsTag = s.indexOf('/Contents', brPos);
  const gapStart = s.indexOf('<', contentsTag);
  const gapEnd = s.indexOf('>', gapStart);
  const gapLenWithBrackets = gapEnd + 1 - gapStart;

  const byteRange = [
    0,
    gapStart,
    gapStart + gapLenWithBrackets,
    out.length - (gapStart + gapLenWithBrackets),
  ];

  // Patch ByteRange *before* digesting — those bytes fall inside the signed range.
  const filled = `/ByteRange [0 ${pad10(byteRange[1])} ${pad10(byteRange[2])} ${pad10(byteRange[3])}]`;
  if (filled.length !== `/ByteRange ${byteRangePlaceholder}`.length) {
    throw new Error('ByteRange patch would change file length');
  }
  out.write(filled, brPos, 'latin1');

  const signedContent = Buffer.concat([
    out.subarray(byteRange[0], byteRange[0] + byteRange[1]),
    out.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  ]);

  const der = sign(signedContent);
  const hex = der.toString('hex').toUpperCase();
  if (hex.length > hexLen) {
    throw new Error(`signature ${der.length} B exceeds reserved ${SIGNATURE_RESERVED_BYTES} B`);
  }
  out.write(hex.padEnd(hexLen, '0'), gapStart + 1, 'latin1');

  return { buffer: out, byteRange, signatureBytes: der.length, sigObjectNumber: sigNum };
}

/**
 * Employee approval (DEC-004 / FR-012): a visible attestation rendered into the
 * reserved widget by incremental update, consuming no eSign transaction and
 * leaving the Agent signature intact.
 */
function appendAttestation(buf, { fieldName, lines, fontObjectNumber }) {
  const doc = parseDocument(buf);
  const field = findFieldByName(buf, doc.offsets, fieldName);

  const rect = /\/Rect\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(field.body);
  if (!rect) throw new Error(`field "${fieldName}" has no /Rect`);
  const w = parseFloat(rect[3]) - parseFloat(rect[1]);
  const h = parseFloat(rect[4]) - parseFloat(rect[2]);

  let ops =
    `q\n0.93 0.97 0.93 rg\n0 0 ${w} ${h} re f\n` +
    `0.18 0.45 0.20 RG 0.75 w\n0.5 0.5 ${w - 1} ${h - 1} re S\n`;
  let y = h - 14;
  lines.forEach((line, i) => {
    const size = i === 0 ? 8 : 6.5;
    ops += `BT /Helv ${size} Tf ${i === 0 ? '0.10 0.35 0.12' : '0.15 0.15 0.15'} rg ` +
      `5 ${y} Td (${escapePdfText(line)}) Tj ET\n`;
    y -= i === 0 ? 12 : 9;
  });
  ops += 'Q\n';

  const xobjNum = doc.size;
  const xobj =
    `<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 ${w} ${h}]` +
    ` /Resources << /Font << /Helv ${fontObjectNumber} 0 R >> /ProcSet [/PDF /Text] >>` +
    ` /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}endstream`;

  const updatedField = injectIntoDict(field.body, `/AP << /N ${xobjNum} 0 R >>`);

  return {
    buffer: appendRevision(buf, doc, [
      { num: xobjNum, gen: 0, content: xobj },
      { num: field.num, gen: field.gen, content: updatedField },
    ]),
    xobjectNumber: xobjNum,
  };
}

module.exports = {
  appendSignature,
  appendAttestation,
  appendRevision,
  pdfDate,
  SIGNATURE_RESERVED_BYTES,
};
