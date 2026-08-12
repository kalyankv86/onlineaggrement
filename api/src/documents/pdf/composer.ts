import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const run = promisify(execFile);

export interface ComposedDocument {
  buffer: Buffer;
  pageCount: number;
  stampPages: number;
}

/**
 * Builds the executable document from what GTIDS supplies (DEC-025, DEC-027).
 *
 * The stamp paper scan is page 1, the agreement follows. This replaces template
 * rendering for uploaded agreements: the portal no longer authors the text, so it
 * cannot reproduce the instrument from data — which is why the uploaded source is
 * retained and hashed in its own right.
 */
@Injectable()
export class DocumentComposer {
  private readonly log = new Logger(DocumentComposer.name);

  /**
   * Convert a Word document to PDF using LibreOffice.
   *
   * Runs headless and offline, which suits a self-hosted server with no outbound
   * access. Conversion is not layout-perfect for complex documents — the operator
   * sees the result before anything is signed, which is the point at which a
   * mangled agreement must be caught.
   */
  async convertToPdf(source: Buffer, filename: string): Promise<Buffer> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtids-convert-'));
    const input = path.join(dir, path.basename(filename).replace(/[^\w.\- ]/g, '_'));
    try {
      await fs.writeFile(input, source);
      await run(
        'soffice',
        [
          '--headless',
          '--norestore',
          // A private profile: concurrent conversions otherwise fight over the
          // default one and fail intermittently under load.
          `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          input,
        ],
        { timeout: 120_000 },
      );

      const produced = (await fs.readdir(dir)).find((f) => f.toLowerCase().endsWith('.pdf'));
      if (!produced) throw new Error('LibreOffice produced no PDF');
      return await fs.readFile(path.join(dir, produced));
    } catch (e) {
      const message = (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'LibreOffice (soffice) is not installed — required to accept Word documents'
        : `Word conversion failed: ${(e as Error).message}`;
      throw new Error(message);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Accept a PDF as-is, or convert a Word document first. */
  async toPdf(source: Buffer, filename: string, contentType: string): Promise<Buffer> {
    const isPdf =
      contentType === 'application/pdf' || source.subarray(0, 5).toString() === '%PDF-';
    if (isPdf) return source;

    const isWord =
      /\.(docx?|odt|rtf)$/i.test(filename) ||
      contentType.includes('word') ||
      contentType.includes('officedocument');
    if (!isWord) {
      throw new Error(
        `Unsupported agreement format "${contentType}". Upload a PDF or a Word document.`,
      );
    }
    return this.convertToPdf(source, filename);
  }

  /**
   * Stamp scan first, agreement after (DEC-027).
   *
   * The scan may be an image or a PDF; images are embedded on their own page at
   * the scan's own aspect ratio rather than stretched to A4, because a distorted
   * stamp is harder to read against the physical original.
   */
  async compose(agreementPdf: Buffer, stampScan?: Buffer): Promise<ComposedDocument> {
    const out = await PDFDocument.create();
    out.setProducer('GTIDS Agreement Portal');
    out.setCreator('GTIDS Agreement Portal');
    out.setCreationDate(new Date());

    let stampPages = 0;
    if (stampScan?.length) {
      stampPages = await this.appendStamp(out, stampScan);
    }

    const agreement = await PDFDocument.load(agreementPdf, { ignoreEncryption: true });
    const copied = await out.copyPages(agreement, agreement.getPageIndices());
    for (const page of copied) out.addPage(page);

    // useObjectStreams:false keeps a classic xref table, which the incremental
    // signer requires — it does not parse cross-reference streams.
    const buffer = Buffer.from(await out.save({ useObjectStreams: false }));
    return { buffer, pageCount: out.getPageCount(), stampPages };
  }

  private async appendStamp(out: PDFDocument, scan: Buffer): Promise<number> {
    if (scan.subarray(0, 5).toString() === '%PDF-') {
      const stampDoc = await PDFDocument.load(scan, { ignoreEncryption: true });
      const pages = await out.copyPages(stampDoc, stampDoc.getPageIndices());
      for (const p of pages) out.addPage(p);
      return pages.length;
    }

    try {
      const isPng = scan.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      const image = isPng ? await out.embedPng(scan) : await out.embedJpg(scan);

      // A4 with a small margin, preserving the scan's aspect ratio.
      const A4 = { w: 595.28, h: 841.89 };
      const margin = 28;
      const fitted = image.scaleToFit(A4.w - margin * 2, A4.h - margin * 2);
      const page = out.addPage([A4.w, A4.h]);
      page.drawImage(image, {
        x: (A4.w - fitted.width) / 2,
        y: (A4.h - fitted.height) / 2,
        width: fitted.width,
        height: fitted.height,
      });
      return 1;
    } catch (e) {
      throw new Error(
        `Stamp scan could not be embedded (${(e as Error).message}). ` +
          'Upload it as PDF, PNG or JPEG.',
      );
    }
  }
}
