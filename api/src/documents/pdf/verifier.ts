import { Injectable, Logger } from '@nestjs/common';
import * as forge from 'node-forge';
import { findSignatures } from './pdf-objects';

export interface SignatureVerdict {
  index: number;
  byteRange: [number, number, number, number];
  coversBytes: number;
  coversWholeFile: boolean;
  signerCommonName?: string;
  signerSerial?: string;
  signingTime?: Date;
  valid: boolean;
  issues: string[];
}

export interface VerificationReport {
  count: number;
  allValid: boolean;
  signatures: SignatureVerdict[];
}

/**
 * Multi-signature verification — SRS v1.1 §8.3.
 *
 * Runs after EVERY signing operation, not only at the end. The obligation is
 * two-part: the new signature must be valid, and every previously applied
 * signature must still be valid. Failure of the second is a SIGNATURE_FAILED
 * condition and a security alert, because it means something rewrote bytes that
 * were supposed to be immutable.
 */
@Injectable()
export class PdfVerifier {
  private readonly log = new Logger(PdfVerifier.name);

  verify(pdf: Buffer): VerificationReport {
    const slots = findSignatures(pdf);
    const signatures = slots.map((slot, i): SignatureVerdict => {
      const issues: string[] = [];

      // Structural: the /Contents gap must sit exactly between the two signed
      // ranges. A mismatch means the ByteRange was rewritten after signing.
      if (slot.byteRange[0] !== 0) issues.push('ByteRange does not start at byte 0');
      if (slot.byteRange[1] !== slot.contentsStart) {
        issues.push(`gap start ${slot.contentsStart} != ByteRange[1] ${slot.byteRange[1]}`);
      }
      if (slot.byteRange[2] !== slot.contentsEnd) {
        issues.push(`gap end ${slot.contentsEnd} != ByteRange[2] ${slot.byteRange[2]}`);
      }

      // A signature from revision k legitimately covers only a prefix of the
      // current file — later revisions were appended after it. What it must never
      // do is claim bytes that do not exist.
      const covers = slot.byteRange[2] + slot.byteRange[3];
      if (covers > pdf.length) issues.push('signature claims bytes past end of file');

      let signerCommonName: string | undefined;
      let signerSerial: string | undefined;
      let signingTime: Date | undefined;

      if (issues.length === 0) {
        try {
          const der = Buffer.from(stripPadding(slot.hex), 'hex');
          const content = Buffer.concat([
            pdf.subarray(slot.byteRange[0], slot.byteRange[0] + slot.byteRange[1]),
            pdf.subarray(slot.byteRange[2], slot.byteRange[2] + slot.byteRange[3]),
          ]);
          const outcome = verifyDetached(der, content);
          if (!outcome.ok) issues.push(outcome.reason ?? 'signed digest does not match document');
          signerCommonName = outcome.commonName;
          signerSerial = outcome.serial;
          signingTime = outcome.signingTime;
        } catch (e) {
          issues.push(`signature could not be parsed: ${(e as Error).message}`);
        }
      }

      return {
        index: i + 1,
        byteRange: slot.byteRange,
        coversBytes: covers,
        coversWholeFile: covers === pdf.length,
        signerCommonName,
        signerSerial,
        signingTime,
        valid: issues.length === 0,
        issues,
      };
    });

    return { count: signatures.length, allValid: signatures.every((s) => s.valid), signatures };
  }

  /**
   * Assert that applying a signature did not disturb the ones already present.
   * `expectedCount` is how many signatures should exist afterwards.
   */
  assertIntegrityAfterSigning(pdf: Buffer, expectedCount: number): VerificationReport {
    const report = this.verify(pdf);
    if (report.count !== expectedCount) {
      throw new Error(
        `expected ${expectedCount} signature(s) after signing but found ${report.count}`,
      );
    }
    if (!report.allValid) {
      const broken = report.signatures.filter((s) => !s.valid);
      throw new Error(
        `signature integrity failure: ${broken
          .map((s) => `#${s.index} (${s.issues.join('; ')})`)
          .join(', ')}`,
      );
    }
    return report;
  }
}

/** The /Contents gap is zero-padded to its reserved length; DER stops before that. */
function stripPadding(hex: string): string {
  const cleaned = hex.replace(/[^0-9A-Fa-f]/g, '');
  const trimmed = cleaned.replace(/(00)+$/, '');
  return trimmed.length % 2 === 0 ? trimmed : `${trimmed}0`;
}

/**
 * Confirm the detached CMS commits to `content`, by comparing the signed
 * messageDigest attribute against SHA-256 of the bytes we believe were signed.
 */
function verifyDetached(
  der: Buffer,
  content: Buffer,
): { ok: boolean; reason?: string; commonName?: string; serial?: string; signingTime?: Date } {
  const asn1 = forge.asn1.fromDer(der.toString('latin1'));
  const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & {
    rawCapture?: { signerInfos?: forge.asn1.Asn1[] };
    certificates?: forge.pki.Certificate[];
  };

  const signer = p7.rawCapture?.signerInfos?.[0] as forge.asn1.Asn1 | undefined;
  if (!signer) return { ok: false, reason: 'CMS carries no signerInfo' };

  const cert = p7.certificates?.[0];
  const commonName = cert?.subject.getField('CN')?.value as string | undefined;
  const serial = cert?.serialNumber;

  const expected = forge.md.sha256.create();
  expected.update(content.toString('latin1'));
  const expectedHex = expected.digest().toHex();

  const attrs = (signer.value as forge.asn1.Asn1[]).find(
    (v) => v.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && v.type === 0,
  );
  if (!attrs) return { ok: false, reason: 'CMS has no authenticated attributes', commonName, serial };

  let signingTime: Date | undefined;
  let digestMatches: boolean | undefined;

  for (const attr of attrs.value as forge.asn1.Asn1[]) {
    const parts = attr.value as forge.asn1.Asn1[];
    const oid = forge.asn1.derToOid(parts[0].value as string);
    const first = (parts[1].value as forge.asn1.Asn1[])[0];
    if (oid === forge.pki.oids.messageDigest) {
      digestMatches = forge.util.bytesToHex(first.value as string) === expectedHex;
    } else if (oid === forge.pki.oids.signingTime) {
      // forge decodes UTCTime/GeneralizedTime into a Date, but types it as the
      // generic ASN.1 value union.
      signingTime = first.value as unknown as Date;
    }
  }

  if (digestMatches === undefined) {
    return { ok: false, reason: 'CMS has no messageDigest attribute', commonName, serial };
  }
  return {
    ok: digestMatches,
    reason: digestMatches ? undefined : 'document bytes do not match the signed digest',
    commonName,
    serial,
    signingTime,
  };
}
