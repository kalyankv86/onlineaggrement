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

/**
 * A scanned ₹100 SHCIL e-Stamp, reproducing the layout of the real Andhra Pradesh
 * certificate GTIDS supplied — including the two traps it contains: the duty
 * amount sits after "Stamp Duty Amount(Rs.)  :" where a bracket breaks a naive
 * pattern, and "Consideration Price (Rs.): 0" appears earlier on the page, so a
 * loose search reads a ₹100 stamp as ₹0.
 */
async function stampPaperScan(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 700]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const plain = await doc.embedFont(StandardFonts.Helvetica);

  let y = 660;
  const line = (t: string, size = 11, font = plain) => {
    page.drawText(t, { x: 36, y, size, font, color: rgb(0, 0, 0) });
    y -= size + 9;
  };

  line('INDIA NON JUDICIAL', 15, bold);
  line('Government of Andhra Pradesh', 14, bold);
  line('e-Stamp', 12);
  line('Certificate No.          :  IN-AP77702625151064Y');
  line('Certificate Issued Date  :  02-Apr-2026 11:05 AM');
  line('Account Reference        :  NEWIMPACC (IV)/ ap18168303/ AP-VKP');
  line('DDO Code                 :  27002308001 O/o IG R');
  line('Unique Doc. Reference    :  SUBIN-APAP1816830336771257804039Y');
  line('Purchased by             :  GRAM TARANG INCLUSIVE DEVELOPMENT SERVICES PVT LTD');
  line('Description of Document  :  Article 7 Agreement');
  line('Property Description     :  BANK GUARANTEE');
  line('Consideration Price (Rs.):  0');
  line('First Party              :  GRAM TARANG INCLUSIVE DEVELOPMENT SERVICES PVT LTD');
  line('Second Party             :  UNION BANK OF INDIA');
  line('Stamp Duty Amount(Rs.)   :  100');
  line('(One Hundred only)');
  line('Please write or type below this line');
  line('FH 0001752181', 13, bold);

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
    'reads all three identifiers from a real AP e-Stamp layout',
    async () => {
      const reading = await ocr.read(await stampPaperScan(), 'application/pdf');

      expect(reading.rawText.length).toBeGreaterThan(50);

      const byKind = Object.fromEntries(reading.identifiers.map((i) => [i.kind, i.value]));
      expect(byKind.CERTIFICATE_NO).toBe('IN-AP77702625151064Y');
      expect(byKind.UNIQUE_DOC_REF).toBe('SUBIN-APAP1816830336771257804039Y');
      expect(byKind.PAPER_SERIAL).toMatch(/FH\s?0001752181/);

      expect(reading.stampNumber).toBe('IN-AP77702625151064Y');
      expect(reading.stateCode).toBe('IN-AP');
      expect(reading.issueDate).toBe('2026-04-02');

      // The duty, not the consideration price printed above it.
      expect(reading.denomination).toBe(100);
      expect(reading.considerationPrice).toBe(0);
      expect(reading.confidence.denomination).toBe('high');

      expect(reading.secondParty).toBe('UNION BANK OF INDIA');
      expect(reading.propertyDescription).toBe('BANK GUARANTEE');
    },
  );

  (ocrAvailable && popplerAvailable ? it : it.skip)(
    'never treats the account reference as identifying the stamp',
    async () => {
      // It names the vendor's account and repeats across every stamp they issue;
      // indexing it uniquely would reject legitimate stamps.
      const reading = await ocr.read(await stampPaperScan(), 'application/pdf');
      expect(reading.identifiers.map((i) => i.kind)).not.toContain('ACCOUNT_REFERENCE');
      expect(reading.accountReference).toMatch(/NEWIMPACC/i);
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
      expect(reading.identifiers).toEqual([]);
      expect(reading.warnings.join(' ')).toMatch(/No identifier could be read/);
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
