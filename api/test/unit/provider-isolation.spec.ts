import * as fs from 'fs';
import * as path from 'path';

/**
 * SDD §20 / SDD v1.1 §B7 — the key design decision, enforced rather than trusted.
 *
 * The GTIDS platform is the system of record; the ESP is a replaceable dependency.
 * That only stays true if provider-specific knowledge cannot leak out of the
 * adapter directory, and the cheapest way to keep it true is to fail the build
 * when it does.
 */
const SRC = path.resolve(__dirname, '../../src');
const ADAPTER_DIR = path.join(SRC, 'esign', 'providers');

/** Names of providers GTIDS might contract (DEC-002), plus the development mock. */
const PROVIDER_NAMES = [
  'emudhra', 'protean', 'nsdl', 'ncode', 'digio', 'leegality', 'signdesk', 'setu', 'zoop',
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

describe('eSign provider isolation (SDD §20)', () => {
  const sourceFiles = walk(SRC).filter((f) => !f.startsWith(ADAPTER_DIR));

  it.each(PROVIDER_NAMES)('no module outside the adapter directory mentions "%s"', (name) => {
    const offenders = sourceFiles.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      // Comments naming candidate providers in a decision reference are fine; code
      // that branches on one is not.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '');
      return new RegExp(`\\b${name}\\b`, 'i').test(code);
    });

    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('only the eSign module constructs a provider', () => {
    const offenders = sourceFiles.filter(
      (file) =>
        /new\s+\w*EsignProvider/.test(fs.readFileSync(file, 'utf8')) &&
        !file.endsWith(path.join('esign', 'esign.module.ts')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('the workflow module holds no provider knowledge', () => {
    // It may reference the `esign_transactions` table — cancelling stale signing
    // transactions during a correction is domain logic (FR-015a). What it must
    // never do is import the provider abstraction or name a vendor, which is what
    // would couple the agreement engine to whoever GTIDS contracts.
    for (const file of walk(path.join(SRC, 'workflow'))) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/from\s+['"].*esign\/provider/);
      expect(text).not.toMatch(/EsignProvider|EsignService/);
      for (const name of PROVIDER_NAMES) {
        expect(text.toLowerCase()).not.toContain(name);
      }
    }
  });

  it('no module outside the adapter imports the PKCS#7 helper', () => {
    // Signature production belongs to the ESP. Anything in GTIDS that can mint a
    // PKCS#7 blob is a place where a signature could be forged.
    const offenders = sourceFiles.filter((file) =>
      /from\s+['"].*providers\/pkcs7['"]/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});

describe('sensitive data handling (SRS §12, AC-21)', () => {
  const sourceFiles = walk(SRC);

  it('no source file persists an Aadhaar number or OTP value', () => {
    const forbidden = /\b(aadhaar_number|aadhaarNumber|otp_value|otpValue|full_aadhaar)\b/i;
    const offenders = sourceFiles.filter((f) => forbidden.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('identity references are masked before storage', () => {
    const util = fs.readFileSync(path.join(SRC, 'common/util/crypto.util.ts'), 'utf8');
    expect(util).toContain('maskIdentity');
  });
});
