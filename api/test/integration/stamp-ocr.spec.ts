import { execFileSync } from 'child_process';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { StampOcrService } from '../../src/stamps/stamp-ocr.service';
import { DocumentComposer } from '../../src/documents/pdf/composer';
import { PdfPreparer, SIGNATURE_FIELDS } from '../../src/documents/pdf/preparer';
import { PdfVerifier } from '../../src/documents/pdf/verifier';
import { appendSignature } from '../../src/documents/pdf/incremental-signer';
import { signingIdentityFor, signDetached } from '../../src/esign/providers/pkcs7';
import { parseDocument } from '../../src/documents/pdf/pdf-objects';

jest.setTimeout(180_000);

/**
 * Probe for a CLI tool. The version flag differs between them — poppler's
 * pdftoppm treats `--version` as a filename and fails — so each is asked the way
 * it expects, rather than skipping the tests that matter on a false negative.
 */
const has = (cmd: string, flag = '--version'): boolean => {
  try {
    execFileSync(cmd, [flag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** A stand-in for a scanned ₹100 non-judicial stamp paper, rendered as a PDF. */
async function stampPaperScan(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 420]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const plain = await doc.embedFont(StandardFonts.Helvetica);

  const line = (t: string, y: number, size = 11, font = plain) =>
    page.drawText(t, { x: 40, y, size, font, color: rgb(0, 0, 0) });

  line('GOVERNMENT OF ODISHA', 380, 15, bold);
  line('INDIA NON JUDICIAL', 358, 13, bold);
  line('e-Stamp', 338, 11);
  line('Certificate No.        : OR12345678901234', 306, 11);
  line('Certificate Issued Date: 14/03/2026', 286, 11);
  line('Account Reference      : NONACC (SV)/ or12345/ OD-KHO', 266, 11);
  line('Stamp Duty Paid By     : GRAMTARANG INCLUSIVE DEVELOPMENT SERVICES', 246, 11);
  line('Description of Document: Article 5 Agreement', 226, 11);
  line('Consideration Price (Rs.): 0', 206, 11);
  line('Rs. 100', 176, 16, bold);
  line('(One Hundred only)', 156, 11);
  line('Licensed Stamp Vendor  : Treasury Bhubaneswar', 130, 11);

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A stand-in for the agreement GTIDS supplies. */
async function agreementDocument(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const plain = await doc.embedFont(StandardFonts.Helvetica);

  for (const n of [1, 2]) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(n === 1 ? 'SERVICE ENGAGEMENT AGREEMENT' : 'SCHEDULE', {
      x: 60, y: 780, size: 14, font: bold,
    });
    page.drawText(`Page ${n} of the agreement supplied by GTIDS.`, {
      x: 60, y: 740, size: 11, font: plain,
    });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const ocrAvailable = has('tesseract');
const popplerAvailable = has('pdftoppm', '-v');

describe('Stamp OCR (DEC-026)', () => {
  const ocr = new StampOcrService();

  (ocrAvailable && popplerAvailable ? it : it.skip)(
    'reads the fields a person then confirms',
    async () => {
      const reading = await ocr.read(await stampPaperScan(), 'application/pdf');

      expect(reading.rawText.length).toBeGreaterThan(50);
      expect(reading.stampNumber).toBe('OR12345678901234');
      expect(reading.denomination).toBe(100);
      expect(reading.stateCode).toBe('IN-OR');
      expect(reading.issueDate).toBe('2026-03-14');
      expect(reading.vendor).toMatch(/Treasury/i);
    },
  );

  (ocrAvailable && popplerAvailable ? it : it.skip)(
    'flags a scan it could not read rather than inventing values',
    async () => {
      const blank = await PDFDocument.create();
      blank.addPage([300, 300]);
      const reading = await ocr.read(
        Buffer.from(await blank.save({ useObjectStreams: false })),
        'application/pdf',
      );

      expect(reading.stampNumber).toBeUndefined();
      expect(reading.warnings.join(' ')).toMatch(/No stamp number could be read/);
    },
  );

  (ocrAvailable ? it : it.skip)('reports availability', async () => {
    expect(await ocr.available()).toBe(true);
  });
});

describe('Composition and signing of an uploaded agreement (DEC-025, DEC-027)', () => {
  const composer = new DocumentComposer();
  const preparer = new PdfPreparer();
  const verifier = new PdfVerifier();

  it('puts the stamp scan first, then the agreement', async () => {
    const composed = await composer.compose(await agreementDocument(), await stampPaperScan());

    expect(composed.stampPages).toBe(1);
    expect(composed.pageCount).toBe(3); // stamp + two agreement pages
    expect(() => parseDocument(composed.buffer)).not.toThrow();
  });

  it('embeds an image stamp scan without distorting it', async () => {
    // 1x1 PNG: proves the image path works; aspect ratio is preserved by scaleToFit.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const composed = await composer.compose(await agreementDocument(), png);
    expect(composed.stampPages).toBe(1);
    expect(composed.pageCount).toBe(3);
  });

  it('rejects a format that is neither PDF nor Word', async () => {
    await expect(
      composer.toPdf(Buffer.from('plain text'), 'notes.txt', 'text/plain'),
    ).rejects.toThrow(/Unsupported agreement format/);
  });

  it('carries two signatures on the composed document, both valid (AC-10, DEC-024)', async () => {
    const composed = await composer.compose(await agreementDocument(), await stampPaperScan());
    const prepared = await preparer.prepare(composed.buffer);

    // Two widgets now, not three — the Employee approval step is gone.
    const text = prepared.buffer.toString('latin1');
    expect(text).toContain(`/T (${SIGNATURE_FIELDS.AGENT})`);
    expect(text).toContain(`/T (${SIGNATURE_FIELDS.MD})`);
    expect(text).not.toContain('GTIDS_Employee');

    const agent = await appendSignature(prepared.buffer, {
      fieldName: SIGNATURE_FIELDS.AGENT,
      name: 'Ramesh Kumar',
      reason: 'Agent execution',
      location: 'Bhubaneswar',
      sign: (c) => signDetached(c, signingIdentityFor('Ramesh Kumar')),
    });
    expect(agent.buffer.subarray(0, prepared.buffer.length).equals(prepared.buffer)).toBe(true);
    expect(verifier.verify(agent.buffer).allValid).toBe(true);

    const md = await appendSignature(agent.buffer, {
      fieldName: SIGNATURE_FIELDS.MD,
      name: 'Dr. A. K. Mohanty',
      reason: 'Final execution',
      location: 'Bhubaneswar',
      sign: (c) => signDetached(c, signingIdentityFor('Dr. A. K. Mohanty')),
    });

    const report = verifier.verify(md.buffer);
    expect(report.count).toBe(2);
    expect(report.allValid).toBe(true);
    expect(report.signatures[0].coversWholeFile).toBe(false);
    expect(report.signatures[1].coversWholeFile).toBe(true);
  });
});
