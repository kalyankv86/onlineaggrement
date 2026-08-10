'use strict';
/**
 * PHASE 2 GATE — DEC-001 / AC-10.
 *
 * Proves the full document pipeline end to end:
 *   render (flat) -> prepare (3 reserved widgets)
 *   -> Agent signs      (incremental update 1)
 *   -> Employee attests (incremental update 2, no eSign transaction)
 *   -> MD signs         (incremental update 3)
 *
 * and asserts after every step that all previously applied signatures REMAIN
 * valid. Phase 3 does not start until this passes.
 *
 *   node run.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { renderFlatAgreement, prepareSignatureFields } = require('./src/prepare');
const { appendSignature, appendAttestation } = require('./src/incremental');
const { verifyAllSignatures } = require('./src/verify');
const { generateSigningCertificate, signDetached } = require('./src/pkcs7');
const { parseDocument, findObjectContaining } = require('./src/pdf-objects');

const OUT = path.join(__dirname, 'out');
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[2m${m}\x1b[0m`);
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

let failures = 0;
function assert(cond, message) {
  if (cond) { ok(message); } else { failures += 1; console.log(`  \x1b[31m✗ ${message}\x1b[0m`); }
}

function write(name, buf) {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  info(`${name}  (${buf.length.toLocaleString()} bytes)`);
  return p;
}

/** Independent, non-GTIDS validation via poppler's pdfsig, when available. */
function pdfsig(file) {
  try {
    return execFileSync('pdfsig', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

async function main() {
  console.log('\n\x1b[1mGTIDS Phase 2 gate — multi-signature PDF integrity\x1b[0m');

  step('0. Signing identities (stand-ins for the ESP-issued certificates)');
  const agentCert = generateSigningCertificate({ commonName: 'Ramesh Kumar (Agent)' });
  const mdCert = generateSigningCertificate({ commonName: 'Managing Director, GTIDS' });
  ok('agent and MD signing certificates generated');

  step('1. Render flat agreement (stand-in for the Playwright renderer)');
  const { bytes: flat } = await renderFlatAgreement({
    agreementNumber: 'GTIDS/2026-27/EMPAGR/000042',
    agentName: 'Ramesh Kumar',
    employeeName: 'Sunita Patnaik',
    mdName: 'Dr. A. K. Mohanty',
  });
  write('1-generated-unsigned.pdf', flat);

  step('2. Prepare — reserve three signature widgets BEFORE any signature exists');
  const prepared = await prepareSignatureFields(flat);
  const preparedPath = write('2-prepared-unsigned.pdf', prepared);
  const preparedDoc = parseDocument(prepared);
  const fontObj = findObjectContaining(prepared, preparedDoc.offsets, '/BaseFont /Helvetica');
  assert(!!fontObj, 'Helvetica font object located for the attestation appearance');
  assert(verifyAllSignatures(prepared).count === 0, 'prepared baseline carries no signatures');
  const baselineLength = prepared.length;

  step('3. Agent signs — incremental update #1');
  const s1 = appendSignature(prepared, {
    fieldName: 'GTIDS_Agent',
    name: 'Ramesh Kumar',
    reason: 'Agent execution of agreement GTIDS/2026-27/EMPAGR/000042',
    location: 'Bhubaneswar, Odisha, IN',
    sign: (content) => signDetached(content, agentCert),
  });
  write('3-agent-signed.pdf', s1.buffer);
  info(`PKCS#7 ${s1.signatureBytes} B of ${8192} B reserved; ByteRange ${JSON.stringify(s1.byteRange)}`);
  assert(
    s1.buffer.subarray(0, baselineLength).equals(prepared),
    'baseline bytes are byte-for-byte unchanged (append-only)',
  );
  const v1 = verifyAllSignatures(s1.buffer);
  assert(v1.count === 1 && v1.allValid, 'signature 1 valid');

  step('4. Employee approves — incremental update #2, no eSign transaction (DEC-004)');
  const a = appendAttestation(s1.buffer, {
    fieldName: 'GTIDS_Employee',
    fontObjectNumber: fontObj.num,
    lines: [
      'APPROVED',
      'Sunita Patnaik (Employee)',
      new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      'Hash verified at approval time',
    ],
  });
  write('4-employee-attested.pdf', a.buffer);
  assert(
    a.buffer.subarray(0, s1.buffer.length).equals(s1.buffer),
    'agent-signed bytes are byte-for-byte unchanged',
  );
  const v2 = verifyAllSignatures(a.buffer);
  assert(v2.count === 1 && v2.allValid, 'signature 1 STILL valid after employee attestation');

  step('5. MD signs — incremental update #3');
  const s3 = appendSignature(a.buffer, {
    fieldName: 'GTIDS_MD',
    name: 'Dr. A. K. Mohanty',
    reason: 'Final execution on behalf of GTIDS',
    location: 'Bhubaneswar, Odisha, IN',
    sign: (content) => signDetached(content, mdCert),
  });
  const finalPath = write('5-final-md-signed.pdf', s3.buffer);
  assert(
    s3.buffer.subarray(0, a.buffer.length).equals(a.buffer),
    'employee-attested bytes are byte-for-byte unchanged',
  );

  step('6. AC-10 — all signatures valid simultaneously');
  const vf = verifyAllSignatures(s3.buffer);
  assert(vf.count === 2, `two cryptographic signatures present (found ${vf.count})`);
  vf.results.forEach((r) => {
    assert(r.valid, `signature ${r.index} valid — covers ${r.coversBytes.toLocaleString()} bytes` +
      (r.coversWholeFile ? ' (whole file)' : ' (prefix; later revisions appended)'));
    r.issues.forEach((i) => info(`      ! ${i}`));
  });
  assert(vf.allValid, 'ALL signatures valid on the final document');

  step('7. Negative control — tampering with signed bytes must be detected');
  const tampered = Buffer.from(s3.buffer);
  const target = tampered.indexOf(Buffer.from('Ramesh Kumar', 'latin1'));
  assert(target !== -1, 'located a signed byte to corrupt');
  tampered.write('Rxmesh Kumar', target, 'latin1');
  const vt = verifyAllSignatures(tampered);
  assert(!vt.allValid, 'tampered document fails verification');
  info(`      detected on signature(s): ${vt.results.filter((r) => !r.valid).map((r) => r.index).join(', ')}`);

  step('8. Independent validation — poppler pdfsig (outside GTIDS code)');
  const report = pdfsig(finalPath);
  const validCount = (report.match(/Signature is Valid/g) || []).length;
  console.log(report.split('\n').map((l) => `      ${l}`).join('\n'));
  if (report.includes('Command not found') || report.trim() === '') {
    info('pdfsig unavailable — skipped (manual Adobe Reader check still required for AC-10)');
  } else {
    assert(validCount === 2, `pdfsig reports 2 valid signatures (got ${validCount})`);
  }

  console.log(
    failures === 0
      ? '\n\x1b[32m\x1b[1mGATE PASSED\x1b[0m — DEC-001 is implementable as specified. Phase 3 may start.\n' +
        `Open ${path.relative(process.cwd(), finalPath)} in Adobe Acrobat Reader to complete AC-10 sign-off.\n`
      : `\n\x1b[31m\x1b[1mGATE FAILED\x1b[0m — ${failures} assertion(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n\x1b[31mSpike crashed:\x1b[0m', e); process.exit(1); });
