import { ConfigService } from '@nestjs/config';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PlaywrightRenderer } from '../../src/documents/pdf/renderer';
import { PdfPreparer, SIGNATURE_FIELDS } from '../../src/documents/pdf/preparer';
import { PdfVerifier } from '../../src/documents/pdf/verifier';
import { appendSignature, appendAttestation } from '../../src/documents/pdf/incremental-signer';
import { parseDocument, findSignatures } from '../../src/documents/pdf/pdf-objects';
import { signingIdentityFor, signDetached } from '../../src/esign/providers/pkcs7';

jest.setTimeout(180_000);

/**
 * The production renderer, proven through the whole signing pipeline.
 *
 * This is the test that had to exist before GTIDS self-hosts. `PDF_RENDERER=playwright`
 * is mandatory in production, and Chromium emits a PDF structured quite differently
 * from the pdf-lib output the Phase 2 gate used — it uses object streams and a
 * cross-reference *stream*, which the incremental signer deliberately does not parse.
 *
 * The pipeline survives that because the Preparer loads the rendered file into
 * pdf-lib and re-saves it with `useObjectStreams: false`, normalising it to a
 * classic xref table before any signature exists. That normalisation is load-bearing,
 * and this test is what stops someone removing it.
 */
const HTML = `
<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 12pt/1.6 Georgia, serif; margin: 0; }
  h1 { font-size: 18pt; border-bottom: 2px solid #333; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
  .sig-band { margin-top: 120px; display: flex; gap: 24px; }
  .sig-box { flex: 1; height: 70px; border: 1px solid #bbb; }
</style></head><body>
  <h1>Service Engagement Agreement</h1>
  <p>This Agreement is made on {{executionDate}} at {{placeOfExecution}} between
     Gramtarang Inclusive Development Services and {{agentName}}.</p>
  <table>
    <tr><th>Consideration</th><td>{{consideration}}</td></tr>
    <tr><th>Term</th><td>{{termMonths}} months</td></tr>
  </table>
  <p>Executed on non-judicial stamp paper of Rs. 100 as affixed.</p>
  <div class="sig-band"><div class="sig-box"></div><div class="sig-box"></div><div class="sig-box"></div></div>
</body></html>`;

const config = {
  get: (key: string) =>
    ({ 'pdf.renderer': 'playwright', 'pdf.signatureReservedBytes': 8192 })[key],
} as unknown as ConfigService;

describe('PlaywrightRenderer in the signing pipeline', () => {
  const renderer = new PlaywrightRenderer(config);
  const preparer = new PdfPreparer();
  const verifier = new PdfVerifier();

  let rendered: Buffer;
  let prepared: Buffer;
  let fontObjectNumber: number;

  beforeAll(async () => {
    rendered = await renderer.render({
      agreementNumber: 'GTIDS/2026-27/SVCAGR/000099',
      templateHtml: HTML,
      variables: {
        executionDate: '2026-08-10',
        placeOfExecution: 'Bhubaneswar, Odisha',
        agentName: 'Ramesh Kumar',
        consideration: 'Rs. 4,50,000',
        termMonths: '12',
      },
    });
    const result = await preparer.prepare(rendered);
    prepared = result.buffer;
    fontObjectNumber = result.fontObjectNumber;
  });

  it('renders real HTML, with CSS applied', () => {
    expect(rendered.subarray(0, 5).toString()).toBe('%PDF-');
    expect(rendered.length).toBeGreaterThan(2000);
  });

  it('Chromium currently emits a classic xref table', () => {
    // True of Chromium 1234 (Playwright 1.62). Recorded because it is the thing
    // that could change: if a future build switches to a cross-reference stream,
    // this assertion fails and points straight at the reason, instead of the
    // failure surfacing later as an unparseable document mid-signing.
    expect(rendered.toString('latin1')).toMatch(/(^|\n)xref\s/);
    expect(() => parseDocument(rendered)).not.toThrow();
  });

  it('the preparer normalises regardless, so the pipeline does not depend on that', () => {
    // pdf-lib re-saves with useObjectStreams:false before any signature exists.
    // That normalisation is what makes the signer independent of whatever the
    // renderer happens to emit — it is load-bearing, not incidental.
    expect(() => parseDocument(prepared)).not.toThrow();
    expect(prepared.toString('latin1')).toMatch(/(^|\n)xref\s/);
    expect(findSignatures(prepared)).toHaveLength(0);
    for (const field of Object.values(SIGNATURE_FIELDS)) {
      expect(prepared.toString('latin1')).toContain(`/T (${field})`);
    }
  });

  it('carries all three actions with every signature valid (AC-10 on the production renderer)', async () => {
    const agent = await appendSignature(prepared, {
      fieldName: SIGNATURE_FIELDS.AGENT,
      name: 'Ramesh Kumar',
      reason: 'Agent execution',
      location: 'Bhubaneswar',
      sign: (c) => signDetached(c, signingIdentityFor('Ramesh Kumar')),
    });
    expect(agent.buffer.subarray(0, prepared.length).equals(prepared)).toBe(true);
    expect(verifier.verify(agent.buffer).allValid).toBe(true);

    const attested = appendAttestation(agent.buffer, {
      fieldName: SIGNATURE_FIELDS.EMPLOYEE,
      lines: ['APPROVED', 'Sunita Patnaik (Employee)'],
      fontObjectNumber,
    }).buffer;
    expect(verifier.verify(attested).allValid).toBe(true);

    const md = await appendSignature(attested, {
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

    // Independent confirmation, if poppler is present on the build machine.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtids-')), 'final.pdf');
    fs.writeFileSync(file, md.buffer);
    try {
      const out = execFileSync('pdfsig', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect((out.match(/Signature is Valid/g) || []).length).toBe(2);
    } catch (e) {
      const out = ((e as { stdout?: string }).stdout ?? '') + ((e as { stderr?: string }).stderr ?? '');
      if (out.includes('Signature')) {
        expect((out.match(/Signature is Valid/g) || []).length).toBe(2);
      } else {
        // pdfsig unavailable — the in-process verifier above already asserted validity.
        expect(report.allValid).toBe(true);
      }
    }
  });
});
