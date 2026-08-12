import { PdfLibRenderer, mergeTemplate } from '../../src/documents/pdf/renderer';
import { PdfPreparer, SIGNATURE_FIELDS } from '../../src/documents/pdf/preparer';
import { PdfVerifier } from '../../src/documents/pdf/verifier';
import {
  prepareSignatureSlot,
  embedSignature,
  reopenSignatureSlot,
  appendSignature,
} from '../../src/documents/pdf/incremental-signer';
import { parseDocument, findSignatures } from '../../src/documents/pdf/pdf-objects';
import { signingIdentityFor, signDetached } from '../../src/esign/providers/pkcs7';
import { sha256 } from '../../src/common/util/crypto.util';

jest.setTimeout(60_000); // RSA-2048 keygen on first use

const TEMPLATE = `
<h1>Service Engagement Agreement</h1>
<p>Between GTIDS and {{agentName}}, dated {{executionDate}}.</p>
<p>Consideration: {{consideration}}.</p>
`;

describe('document pipeline', () => {
  const renderer = new PdfLibRenderer();
  const preparer = new PdfPreparer();
  const verifier = new PdfVerifier();

  let flat: Buffer;
  let prepared: Buffer;

  beforeAll(async () => {
    flat = await renderer.render({
      agreementNumber: 'GTIDS/2026-27/SVCAGR/000001',
      templateHtml: TEMPLATE,
      variables: { agentName: 'Ramesh Kumar', executionDate: '2026-08-09', consideration: 'Rs. 50,000' },
    });
    prepared = (await preparer.prepare(flat)).buffer;
  });

  describe('template merge', () => {
    it('substitutes declared variables', () => {
      expect(mergeTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
    });

    it('leaves an unknown placeholder visible rather than blanking it', () => {
      // A silently-blanked clause in an executed agreement is far worse than an
      // obviously broken one.
      expect(mergeTemplate('Pay {{amount}}', {})).toBe('Pay {{amount}}');
    });

    it('resolves dotted paths', () => {
      expect(mergeTemplate('{{party.name}}', { party: { name: 'GTIDS' } })).toBe('GTIDS');
    });
  });

  describe('preparation', () => {
    it('produces a parseable document with a classic xref table', () => {
      expect(() => parseDocument(prepared)).not.toThrow();
    });

    it('reserves both signature widgets before any signature exists', () => {
      const text = prepared.toString('latin1');
      for (const field of Object.values(SIGNATURE_FIELDS)) {
        expect(text).toContain(`/T (${field})`);
      }
      // DEC-024 removed the employee approval step, so no widget is reserved for it.
      expect(Object.keys(SIGNATURE_FIELDS)).toEqual(['AGENT', 'MD']);
      expect(text).not.toContain('GTIDS_Employee');
      expect(findSignatures(prepared)).toHaveLength(0);
    });

    it('marks the AcroForm append-only', () => {
      expect(prepared.toString('latin1')).toContain('/SigFlags 3');
    });
  });

  describe('AC-10 — two sequential signatures, both remain valid', () => {
    let agentSigned: Buffer;
    let final: Buffer;

    it('applies the agent signature as an append-only revision', async () => {
      const result = await appendSignature(prepared, {
        fieldName: SIGNATURE_FIELDS.AGENT,
        name: 'Ramesh Kumar',
        reason: 'Agent execution',
        location: 'Bhubaneswar',
        sign: (content) => signDetached(content, signingIdentityFor('Ramesh Kumar')),
      });
      agentSigned = result.buffer;

      // The property the whole design rests on: nothing before this revision moved.
      expect(agentSigned.subarray(0, prepared.length).equals(prepared)).toBe(true);
      expect(verifier.verify(agentSigned).allValid).toBe(true);
      expect(verifier.verify(agentSigned).count).toBe(1);
    });

    it('applies the MD signature with both signatures valid afterwards', async () => {
      const result = await appendSignature(agentSigned, {
        fieldName: SIGNATURE_FIELDS.MD,
        name: 'Dr. A. K. Mohanty',
        reason: 'Final execution',
        location: 'Bhubaneswar',
        sign: (content) => signDetached(content, signingIdentityFor('Dr. A. K. Mohanty')),
      });
      final = result.buffer;

      expect(final.subarray(0, agentSigned.length).equals(agentSigned)).toBe(true);
      const report = verifier.verify(final);
      expect(report.count).toBe(2);
      expect(report.allValid).toBe(true);
    });

    it('the agent signature covers a prefix and the MD signature the whole file', () => {
      const report = verifier.verify(final);
      expect(report.signatures[0].coversWholeFile).toBe(false);
      expect(report.signatures[1].coversWholeFile).toBe(true);
    });

    it('names the signer of each signature from its certificate', () => {
      const report = verifier.verify(final);
      expect(report.signatures[0].signerCommonName).toBe('Ramesh Kumar');
      expect(report.signatures[1].signerCommonName).toBe('Dr. A. K. Mohanty');
    });

    it('refuses to sign a field that is already signed', async () => {
      await expect(
        appendSignature(final, {
          fieldName: SIGNATURE_FIELDS.AGENT,
          name: 'Impostor',
          reason: 'x',
          location: 'x',
          sign: (c) => signDetached(c, signingIdentityFor('Impostor')),
        }),
      ).rejects.toThrow(/already signed/);
    });

    describe('tamper detection', () => {
      it('detects a change to signed content', () => {
        const tampered = Buffer.from(final);
        const at = tampered.indexOf(Buffer.from('Ramesh Kumar', 'latin1'));
        expect(at).toBeGreaterThan(-1);
        tampered.write('Rxmesh Kumar', at, 'latin1');
        expect(verifier.verify(tampered).allValid).toBe(false);
      });

      it('detects a rewritten ByteRange', () => {
        const tampered = Buffer.from(final);
        const at = tampered.indexOf(Buffer.from('/ByteRange [0 ', 'latin1'));
        tampered.write('/ByteRange [0 0000000001', at, 'latin1');
        const report = verifier.verify(tampered);
        expect(report.allValid).toBe(false);
        expect(report.signatures.some((s) => s.issues.some((i) => /gap start/.test(i)))).toBe(true);
      });

      it('assertIntegrityAfterSigning throws when a prior signature breaks', () => {
        const tampered = Buffer.from(final);
        // Flip a byte well inside the first signature's covered range. Chosen by
        // offset rather than by searching for text: pdf-lib compresses content
        // streams, so the rendered words are not present as literal bytes.
        const target = 200;
        expect(target).toBeLessThan(verifier.verify(final).signatures[0].byteRange[1]);
        tampered[target] ^= 0xff;

        expect(() => verifier.assertIntegrityAfterSigning(tampered, 2)).toThrow(
          /signature integrity failure/,
        );
      });

      it('rejects a document with an unexpected signature count', () => {
        expect(() => verifier.assertIntegrityAfterSigning(final, 3)).toThrow(
          /expected 3 signature\(s\) after signing but found 2/,
        );
      });
    });
  });

  describe('two-phase signing (real ESP flow)', () => {
    it('prepare publishes a digest without producing a signature', () => {
      const slot = prepareSignatureSlot(prepared, {
        fieldName: SIGNATURE_FIELDS.AGENT,
        name: 'Ramesh Kumar',
        reason: 'Agent execution',
        location: 'Bhubaneswar',
      });
      expect(slot.signedContent.length).toBeGreaterThan(0);
      expect(sha256(slot.signedContent)).toHaveLength(64);
      // The gap is still empty — nothing has been signed.
      expect(findSignatures(slot.buffer)[0].hex).toMatch(/^0+$/);
    });

    it('a slot survives a round trip through storage and still verifies', () => {
      const slot = prepareSignatureSlot(prepared, {
        fieldName: SIGNATURE_FIELDS.AGENT,
        name: 'Ramesh Kumar',
        reason: 'Agent execution',
        location: 'Bhubaneswar',
      });

      // Simulates the callback landing on a different API instance: the slot is
      // rebuilt from the parked bytes, not from process memory.
      const parked = Buffer.from(slot.buffer);
      const reopened = reopenSignatureSlot(parked);
      expect(sha256(reopened.signedContent)).toBe(sha256(slot.signedContent));

      const der = signDetached(reopened.signedContent, signingIdentityFor('Ramesh Kumar'));
      const signed = embedSignature(reopened, der);
      expect(verifier.verify(signed).allValid).toBe(true);
    });

    it('refuses a signature larger than the reserved gap rather than truncating', () => {
      const slot = prepareSignatureSlot(prepared, {
        fieldName: SIGNATURE_FIELDS.AGENT,
        name: 'Ramesh Kumar',
        reason: 'r',
        location: 'l',
        reservedBytes: 64, // far too small for a real CMS blob
      });
      expect(() => embedSignature(slot, Buffer.alloc(256, 1))).toThrow(/only 64 are reserved/);
    });

    it('refuses to reopen a document with no unfilled slot', () => {
      expect(() => reopenSignatureSlot(prepared)).toThrow(/no unfilled signature slot/);
    });
  });
});
