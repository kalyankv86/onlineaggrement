import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const run = promisify(execFile);

/**
 * Kinds that identify one physical stamp. The account reference is excluded on
 * purpose: it names the vendor's account and repeats across every stamp they
 * issue, so treating it as unique would reject legitimate stamps.
 */
export type StampIdentifierKind = 'CERTIFICATE_NO' | 'UNIQUE_DOC_REF' | 'PAPER_SERIAL';

export interface StampIdentifier {
  kind: StampIdentifierKind;
  value: string;
}

export interface StampReading {
  /** Everything Tesseract saw, kept so an operator can check a doubtful field. */
  rawText: string;
  /** Every identifier printed on the paper — each is independently unique. */
  identifiers: StampIdentifier[];
  /** The certificate number, or whichever identifier is the primary one. */
  stampNumber?: string;
  denomination?: number;
  stateCode?: string;
  issueDate?: string;
  vendor?: string;
  issuer?: string;
  accountReference?: string;
  ddoCode?: string;
  documentDescription?: string;
  propertyDescription?: string;
  considerationPrice?: number;
  firstParty?: string;
  secondParty?: string;
  /** Per-field, so the UI can highlight what it is unsure about. */
  confidence: Record<string, 'high' | 'low'>;
  warnings: string[];
}

/** Uppercase alphanumerics: the form uniqueness is enforced on (migration 014). */
export const normalizeIdentifier = (value: string): string =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, '');

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

    /*
     * Identifiers. A SHCIL e-Stamp prints three, and each is independently unique
     * (migration 014): recording all of them means getting any one right is enough
     * to catch a stamp entered twice.
     */
    const identifiers: StampIdentifier[] = [];
    const addIdentifier = (kind: StampIdentifierKind, value?: string) => {
      if (!value) return;
      const trimmed = value.trim().replace(/[.,;]+$/, '').toUpperCase();
      if (normalizeIdentifier(trimmed).length < 6) return;
      if (identifiers.some((i) => normalizeIdentifier(i.value) === normalizeIdentifier(trimmed))) return;
      identifiers.push({ kind, value: trimmed });
    };

    // Anchored on the printed label. An unanchored search picks up whichever
    // long token appears first, which on this layout is the barcode.
    const labelled = (label: RegExp): string | undefined => flat.match(label)?.[1]?.trim();

    /*
     * Free-text values are read line by line, not from the flattened text.
     * Flattening runs one value into the next label — "BANK GUARANTEE" became
     * "BANK GUARANTEE Consideration Price" — because a permissive character class
     * has nothing to stop at. Each label and value occupy their own line.
     */
    const lineValue = (label: RegExp): string | undefined => {
      for (const line of text.split('\n')) {
        const m = line.match(new RegExp(`^\\s*${label.source}\\s*[:\\-]\\s*(.+?)\\s*$`, 'i'));
        if (m?.[1]) return m[1].trim();
      }
      return undefined;
    };

    const certificateNo = labelled(
      /(?:certificate\s*no|cert\.?\s*no|stamp\s*no|serial\s*no)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{5,30})/i,
    );
    const uniqueDocRef = labelled(
      /unique\s*doc\.?\s*reference\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{5,45})/i,
    );
    addIdentifier('CERTIFICATE_NO', certificateNo);
    addIdentifier('UNIQUE_DOC_REF', uniqueDocRef);

    // Stored, but never treated as identifying the individual stamp.
    const accountReference = lineValue(/account\s*reference/);
    const ddoCode = lineValue(/ddo\s*code/);

    // The pre-printed paper serial, usually bottom-right and rarely labelled:
    // two letters, whitespace, then a long run of digits.
    const serial = flat.match(/\b([A-Z]{2}\s?\d{7,12})\b/);
    if (serial && !/^(IN|SU)/i.test(serial[1])) addIdentifier('PAPER_SERIAL', serial[1]);

    let stampNumber = certificateNo?.toUpperCase();
    if (stampNumber) {
      confidence.stampNumber = 'high';
    } else if (identifiers.length > 0) {
      // Fall back to whatever was found, so the operator has something to check
      // against the paper rather than an empty field.
      stampNumber = identifiers[0].value;
      confidence.stampNumber = 'low';
      warnings.push('No certificate number was labelled — using another identifier from the scan.');
    }
    if (stampNumber && /[OIl]/.test(stampNumber.replace(/^IN-?/i, ''))) {
      confidence.stampNumber = 'low';
      warnings.push('Stamp number contains characters commonly confused by OCR (O/0, I/1).');
    }

    /*
     * Duty amount, anchored on its own label.
     *
     * An unanchored "Rs. <number>" search is wrong on the real layout twice over:
     * the value sits after "Stamp Duty Amount(Rs.)  :", where the bracket breaks a
     * naive pattern, and "Consideration Price (Rs.): 0" appears earlier on the
     * page — so the loose version reads a ₹100 stamp as ₹0.
     */
    let denomination: number | undefined;
    const duty = flat.match(
      /stamp\s*duty\s*(?:amount)?\s*\(?\s*(?:rs\.?|inr|₹)?\s*\)?\s*[:\-]?\s*([0-9][0-9,]{0,8})/i,
    );
    if (duty) {
      denomination = Number(duty[1].replace(/,/g, ''));
      confidence.denomination = 'high';
    } else {
      const anyAmount = flat.match(/(?:rs\.?|inr|₹)\s*\.?\s*([0-9][0-9,]{0,8})/i);
      if (anyAmount) {
        denomination = Number(anyAmount[1].replace(/,/g, ''));
        confidence.denomination = 'low';
        warnings.push('Duty amount was not labelled — check it against the paper.');
      } else if (/one\s+hundred/i.test(flat)) {
        denomination = 100;
        confidence.denomination = 'low';
        warnings.push('Duty amount read from words rather than figures.');
      }
    }
    if (denomination !== undefined && denomination !== 100) {
      warnings.push(`Read a duty of ₹${denomination}, not ₹100 — confirm before saving.`);
      confidence.denomination = 'low';
    }

    const considerationMatch = flat.match(
      /consideration\s*price\s*\(?\s*(?:rs\.?)?\s*\)?\s*[:\-]?\s*([0-9][0-9,]{0,10})/i,
    );
    const considerationPrice = considerationMatch
      ? Number(considerationMatch[1].replace(/,/g, ''))
      : undefined;

    // Descriptive fields, useful for cross-checking against the agreement.
    const documentDescription = lineValue(/description\s*of\s*document/);
    const propertyDescription = lineValue(/property\s*description/);
    const firstParty = lineValue(/first\s*party/);
    const secondParty = lineValue(/second\s*party/);
    const issuer = /shcil|stock\s*holding/i.test(flat)
      ? 'SHCIL'
      : /e-?stamp/i.test(flat)
        ? 'E-STAMP'
        : undefined;

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
    if (identifiers.length === 0) {
      warnings.push('No identifier could be read. Enter the certificate number from the physical paper.');
    }

    return {
      rawText: text,
      identifiers,
      stampNumber,
      denomination,
      stateCode,
      issueDate,
      vendor,
      issuer,
      accountReference,
      ddoCode,
      documentDescription,
      propertyDescription,
      considerationPrice,
      firstParty,
      secondParty,
      confidence,
      warnings,
    };
  }
}
