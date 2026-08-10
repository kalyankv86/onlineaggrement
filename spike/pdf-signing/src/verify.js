'use strict';
/**
 * Multi-signature verification (SRS v1.1 §8.3): after every signing operation the
 * system must assert that the new signature is valid AND that every previously
 * applied signature is still valid. Failure of the latter is SIGNATURE_FAILED and
 * raises a security alert.
 */

const { findSignatures } = require('./pdf-objects');
const { verifyMessageDigest } = require('./pkcs7');

/** Bytes covered by a /ByteRange, concatenated in order. */
function contentForByteRange(buf, byteRange) {
  const [s1, l1, s2, l2] = byteRange;
  if (s1 + l1 > buf.length || s2 + l2 > buf.length) {
    throw new Error('ByteRange extends beyond end of file');
  }
  return Buffer.concat([buf.subarray(s1, s1 + l1), buf.subarray(s2, s2 + l2)]);
}

function verifyAllSignatures(buf) {
  const sigs = findSignatures(buf);
  const results = sigs.map((sig, i) => {
    const issues = [];

    // Structural: the gap must sit exactly between the two signed ranges.
    if (sig.byteRange[0] !== 0) issues.push('ByteRange does not start at 0');
    if (sig.byteRange[1] !== sig.contentsStart) {
      issues.push(`gap start ${sig.contentsStart} != ByteRange[1] ${sig.byteRange[1]}`);
    }
    if (sig.byteRange[2] !== sig.contentsEnd) {
      issues.push(`gap end ${sig.contentsEnd} != ByteRange[2] ${sig.byteRange[2]}`);
    }

    // A signature from revision k covers a prefix of the current file. It may end
    // before EOF (later revisions were appended) but must never claim bytes that
    // do not exist.
    const covered = sig.byteRange[2] + sig.byteRange[3];
    if (covered > buf.length) issues.push('signature claims bytes past EOF');

    let digest = { ok: false, reason: 'not evaluated' };
    try {
      const der = Buffer.from(sig.hex.replace(/0+$/, '').replace(/[^0-9A-Fa-f]/g, ''), 'hex');
      digest = verifyMessageDigest(der, contentForByteRange(buf, sig.byteRange));
    } catch (e) {
      digest = { ok: false, reason: e.message };
    }
    if (!digest.ok) issues.push(`signed digest mismatch (${digest.reason || 'hash differs'})`);

    return {
      index: i + 1,
      byteRange: sig.byteRange,
      coversBytes: covered,
      coversWholeFile: covered === buf.length,
      valid: issues.length === 0,
      issues,
    };
  });

  return { count: results.length, allValid: results.every((r) => r.valid), results };
}

module.exports = { verifyAllSignatures, contentForByteRange };
