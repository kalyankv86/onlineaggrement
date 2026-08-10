import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';

export interface RenderRequest {
  agreementNumber: string;
  /** Template HTML with {{variable}} placeholders already selected, not yet merged. */
  templateHtml: string;
  variables: Record<string, unknown>;
  stampScan?: Buffer;
}

/**
 * Stage 1 of the document pipeline: template + data -> flat PDF.
 *
 * This runs EXACTLY ONCE per agreement version. Everything after it is an
 * incremental update (see incremental-signer.ts) — calling a renderer on a
 * document that already carries a signature would rewrite the file and destroy
 * that signature.
 */
export abstract class PdfRenderer {
  abstract render(req: RenderRequest): Promise<Buffer>;
}

/** Substitute {{variables}}; an unknown placeholder is left visible, not silently blanked. */
export function mergeTemplate(html: string, variables: Record<string, unknown>): string {
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], variables);
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * Dependency-free renderer for development and CI.
 *
 * It lays out the template's text content rather than performing real HTML
 * layout — no CSS, no tables, no images beyond the stamp scan. That is a
 * deliberate trade: it keeps `npm test` free of a 300 MB Chromium download while
 * exercising the parts of the pipeline that carry legal weight (field placement,
 * hashing, signing). Production must run PDF_RENDERER=playwright.
 */
@Injectable()
export class PdfLibRenderer extends PdfRenderer {
  private readonly log = new Logger(PdfLibRenderer.name);

  async render(req: RenderRequest): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.setTitle(`GTIDS Agreement ${req.agreementNumber}`);
    doc.setProducer('GTIDS Agreement Portal');
    doc.setCreator('GTIDS Agreement Portal');
    doc.setCreationDate(new Date());

    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    let page = doc.addPage([595.28, 841.89]); // A4
    let y = 780;

    const newPage = () => {
      page = doc.addPage([595.28, 841.89]);
      y = 780;
    };
    const line = (text: string, size = 10, font: PDFFont = helv) => {
      if (y < 200) newPage();
      page.drawText(text, { x: 60, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      y -= size + 5;
    };

    line('GRAMTARANG INCLUSIVE DEVELOPMENT SERVICES', 13, bold);
    line(`Agreement Number: ${req.agreementNumber}`, 10, bold);
    page.drawLine({
      start: { x: 60, y: y + 4 },
      end: { x: 535, y: y + 4 },
      thickness: 1,
      color: rgb(0.4, 0.4, 0.4),
    });
    y -= 14;

    for (const paragraph of htmlToParagraphs(mergeTemplate(req.templateHtml, req.variables))) {
      for (const wrapped of wrap(paragraph, helv, 10, 475)) line(wrapped, 10);
      y -= 6;
    }

    if (req.stampScan) {
      await this.drawStamp(doc, page, req.stampScan);
    }

    this.reserveSignatureBand(page);
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }

  /** Embed the physical stamp-paper scan (FR-005) if it is a format pdf-lib accepts. */
  private async drawStamp(doc: PDFDocument, page: PDFPage, scan: Buffer): Promise<void> {
    try {
      const isPng = scan.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      const image = isPng ? await doc.embedPng(scan) : await doc.embedJpg(scan);
      const scaled = image.scaleToFit(160, 200);
      page.drawImage(image, { x: 380, y: 620, width: scaled.width, height: scaled.height });
    } catch (e) {
      // A stamp scan that cannot be embedded must not silently vanish from the
      // record, but it must also not block execution of the agreement.
      this.log.warn(`stamp scan could not be embedded (${(e as Error).message}); referenced by hash only`);
    }
  }

  /** Labels under the three reserved signature widgets that preparer.ts will add. */
  private reserveSignatureBand(page: PDFPage): void {
    const labels = [
      { x: 60, text: 'Agent' },
      { x: 215, text: 'Employee (approval)' },
      { x: 370, text: 'Managing Director' },
    ];
    for (const l of labels) {
      page.drawRectangle({
        x: l.x,
        y: 90,
        width: 150,
        height: 70,
        borderColor: rgb(0.65, 0.65, 0.65),
        borderWidth: 0.75,
      });
      page.drawText(l.text, { x: l.x + 2, y: 78, size: 8, color: rgb(0.35, 0.35, 0.35) });
    }
  }
}

/**
 * Production renderer. Kept behind a lazy require so that `playwright` is an
 * optional dependency — CI and local development never download Chromium.
 */
@Injectable()
export class PlaywrightRenderer extends PdfRenderer {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async render(req: RenderRequest): Promise<Buffer> {
    // Untyped on purpose: `playwright` is an optional dependency, so a static
    // import type would break the build wherever it is not installed.
    let chromium: any;
    try {
      ({ chromium } = require('playwright'));
    } catch {
      throw new Error(
        'PDF_RENDERER=playwright but the playwright package is not installed. ' +
          'Run: npm i playwright && npx playwright install chromium',
      );
    }

    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(mergeTemplate(req.templateHtml, req.variables), {
        waitUntil: 'networkidle',
      });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', bottom: '30mm', left: '18mm', right: '18mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}

function htmlToParagraphs(html: string): string[] {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
