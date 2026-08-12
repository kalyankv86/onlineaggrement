import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const run = promisify(execFile);

export interface StampReading {
  /** Everything Tesseract saw, kept so an operator can check a doubtful field. */
  rawText: string;
  stampNumber?: string;
  denomination?: number;
  stateCode?: string;
  issueDate?: string;
  vendor?: string;
  /** Per-field, so the UI can highlight what it is unsure about. */
  confidence: Record<string, 'high' | 'low'>;
  warnings: string[];
}

/**
 * Reads a scanned ₹100 non-judicial stamp paper (DEC-026).
 *
 * Tesseract runs offline, which suits a self-hosted server with no outbound
 * access.
 *
 * The result is always a *proposal*. A misread stamp number becomes the legal
 * identifier of the instrument and is the value BR-006 uniqueness is enforced on,
 * so an OCR error could quietly return a used stamp to circulation. Automatic
 * acceptance was offered to GTIDS and declined; nothing here writes a stamp
 * record, it only pre-fills a form a person must confirm.
 */
@Injectable()
export class StampOcrService {
  private readonly log = new Logger(StampOcrService.name);

  async available(): Promise<boolean> {
    try {
      await run('tesseract', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async read(scan: Buffer, contentType: string): Promise<StampReading> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtids-ocr-'));
    try {
      const image = await this.toImage(scan, contentType, dir);
      const base = path.join(dir, 'out');

      // psm 6: a stamp paper is a single uniform block of text. The default
      // (fully automatic page segmentation) does poorly on the dense header where
      // the certificate number lives.
      await run('tesseract', [image, base, '--psm', '6', '-l', 'eng'], { timeout: 120_000 });
      const rawText = await fs.readFile(`${base}.txt`, 'utf8');

      return this.extract(rawText);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new Error(
          'tesseract-ocr is not installed on this server — install it, or enter the stamp details by hand',
        );
      }
      throw new Error(`Could not read the stamp scan: ${(e as Error).message}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Tesseract needs a raster image; a PDF scan is rendered first with poppler. */
  private async toImage(scan: Buffer, contentType: string, dir: string): Promise<string> {
    if (scan.subarray(0, 5).toString() === '%PDF-' || contentType === 'application/pdf') {
      const pdf = path.join(dir, 'scan.pdf');
      await fs.writeFile(pdf, scan);
      // 300 dpi: below about 200 the certificate number becomes unreliable.
      await run('pdftoppm', ['-r', '300', '-png', '-f', '1', '-l', '1', pdf, path.join(dir, 'page')], {
        timeout: 120_000,
      });
      const produced = (await fs.readdir(dir)).find((f) => f.startsWith('page') && f.endsWith('.png'));
      if (!produced) throw new Error('could not render the PDF scan to an image');
      return path.join(dir, produced);
    }

    const image = path.join(dir, 'scan.img');
    await fs.writeFile(image, scan);
    return image;
  }

  /**
   * Pull the fields out of the OCR text.
   *
   * Indian non-judicial stamp papers vary by state and vendor, so these patterns
   * are best-effort by nature. Anything not found is left blank for the operator
   * rather than guessed at.
   */
  private extract(rawText: string): StampReading {
    const text = rawText.replace(/\r/g, '');
    const flat = text.replace(/\s+/g, ' ');
    const confidence: Record<string, 'high' | 'low'> = {};
    const warnings: string[] = [];

    // Certificate / stamp number: usually labelled, and long. OCR commonly
    // confuses O/0 and I/1 in these, which is precisely why it is confirmed.
    let stampNumber: string | undefined;
    const labelled = flat.match(
      /(?:certificate\s*no|cert\.?\s*no|stamp\s*no|serial\s*no)\.?\s*[:\-]?\s*([A-Z0-9\-\/]{6,25})/i,
    );
    if (labelled) {
      stampNumber = labelled[1].toUpperCase();
      confidence.stampNumber = 'high';
    } else {
      const bare = flat.match(/\b([A-Z]{2}[A-Z0-9]{6,20})\b/);
      if (bare) {
        stampNumber = bare[1].toUpperCase();
        confidence.stampNumber = 'low';
        warnings.push('Stamp number was not labelled in the scan — check it carefully.');
      }
    }
    if (stampNumber && /[OIl]/.test(stampNumber)) {
      confidence.stampNumber = 'low';
      warnings.push('Stamp number contains characters commonly confused by OCR (O/0, I/1).');
    }

    // Denomination.
    let denomination: number | undefined;
    const amount = flat.match(/(?:rs\.?|inr|₹)\s*([0-9][0-9,]{0,8})/i);
    if (amount) {
      denomination = Number(amount[1].replace(/,/g, ''));
      confidence.denomination = 'high';
    } else if (/one\s+hundred/i.test(flat)) {
      denomination = 100;
      confidence.denomination = 'low';
    }
    if (denomination !== undefined && denomination !== 100) {
      warnings.push(`Read a denomination of ₹${denomination}, not ₹100 — confirm before saving.`);
      confidence.denomination = 'low';
    }

    // Issue or purchase date, in the formats these papers actually use.
    let issueDate: string | undefined;
    const dmy = flat.match(/\b([0-3]?\d)[\/\-.]([01]?\d)[\/\-.](\d{4})\b/);
    const dMonY = flat.match(/\b([0-3]?\d)[\s\-]([A-Za-z]{3,9})[\s\-](\d{4})\b/);
    if (dmy) {
      issueDate = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
      confidence.issueDate = 'high';
    } else if (dMonY) {
      const month = new Date(`${dMonY[2]} 1, 2000`).getMonth();
      if (!Number.isNaN(month)) {
        issueDate = `${dMonY[3]}-${String(month + 1).padStart(2, '0')}-${dMonY[1].padStart(2, '0')}`;
        confidence.issueDate = 'low';
      }
    }

    // State, from the issuing government named on the paper.
    const states: Record<string, string> = {
      odisha: 'IN-OR', orissa: 'IN-OR', 'west bengal': 'IN-WB', karnataka: 'IN-KA',
      maharashtra: 'IN-MH', delhi: 'IN-DL', 'tamil nadu': 'IN-TN', telangana: 'IN-TG',
      kerala: 'IN-KL', gujarat: 'IN-GJ', rajasthan: 'IN-RJ', punjab: 'IN-PB',
      haryana: 'IN-HR', bihar: 'IN-BR', jharkhand: 'IN-JH', assam: 'IN-AS',
      'andhra pradesh': 'IN-AP', 'uttar pradesh': 'IN-UP', 'madhya pradesh': 'IN-MP',
      chhattisgarh: 'IN-CT', uttarakhand: 'IN-UT', goa: 'IN-GA',
    };
    let stateCode: string | undefined;
    for (const [name, code] of Object.entries(states)) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(flat)) {
        stateCode = code;
        confidence.stateCode = 'high';
        break;
      }
    }

    const vendorMatch = flat.match(/(?:vendor|licensed\s*stamp\s*vendor)\s*[:\-]?\s*([A-Za-z .,&]{4,60})/i);
    const vendor = vendorMatch?.[1].trim();

    if (text.trim().length < 40) {
      warnings.push('Very little text was readable — the scan may be low resolution or skewed.');
    }
    if (!stampNumber) {
      warnings.push('No stamp number could be read. Enter it from the physical paper.');
    }

    return { rawText: text, stampNumber, denomination, stateCode, issueDate, vendor, confidence, warnings };
  }
}
