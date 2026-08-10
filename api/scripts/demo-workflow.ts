/**
 * End-to-end demonstration against a running deployment.
 *
 ary
 *   API=https://uat.example npm run demo
 *
 * Drives the complete mandated sequence over HTTP as the four principals would,
 * then verifies the result the way an auditor and a counterparty would: signature
 * validity, audit-chain integrity, and public QR verification.
 *
 * Writes the final signed PDF to ./demo-output/ so it can be opened in Adobe
 * Acrobat Reader — the remaining manual step for AC-10 sign-off.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

const API = process.env.API ?? 'http://localhost:3100';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'ChangeMe-Dev-2026!';
const OUT = path.resolve(process.cwd(), 'demo-output');

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};
const step = (n: string) => console.log(`\n${c.bold}${n}${c.reset}`);
const ok = (m: string) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const info = (m: string) => console.log(`  ${c.dim}${m}${c.reset}`);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) ok(message);
  else {
    failures += 1;
    console.log(`  ${c.red}✗ ${message}${c.reset}`);
  }
}

async function call<T = any>(
  method: string,
  route: string,
  opts: { token?: string; body?: unknown; expect?: number } = {},
): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};

  if (opts.expect !== undefined && res.status !== opts.expect) {
    throw new Error(
      `${method} ${route} expected ${opts.expect}, got ${res.status}: ${JSON.stringify(parsed)}`,
    );
  }
  if (opts.expect === undefined && res.status >= 400) {
    throw new Error(`${method} ${route} failed ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

const login = async (email: string): Promise<string> =>
  (await call<{ accessToken: string }>('POST', '/api/v1/auth/login', {
    body: { email, password: PASSWORD },
  })).accessToken;

/** A minimal but structurally valid PDF, standing in for a scanned stamp paper. */
const stampScan = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
).toString('base64');

async function main(): Promise<void> {
  console.log(`\n${c.bold}GTIDS Agreement Portal — end-to-end demonstration${c.reset}`);
  info(`target: ${API}`);

  step('0. Deployment health');
  const ready = await call('GET', '/api/v1/health/ready');
  check(ready.status === 'ready', `service ready — database ${ready.checks.database.ok ? 'up' : 'down'}`);
  info(`eSign provider: ${ready.checks.esignProvider.detail}`);
  if (String(ready.checks.esignProvider.detail).startsWith('mock')) {
    console.log(`  ${c.yellow}note${c.reset} ${c.dim}running on the mock provider — DEC-002 is still open${c.reset}`);
  }

  step('1. Sign in as each principal');
  const tokens = {
    ops: await login('ops@gtids.example'),
    agent: await login('agent@gtids.example'),
    employee: await login('employee@gtids.example'),
    md: await login('md@gtids.example'),
    auditor: await login('auditor@gtids.example'),
  };
  ok('operations, agent, employee, MD and auditor authenticated');

  step('2. Register a physical Rs.100 stamp paper (FR-005)');
  const stamp = await call('POST', '/api/v1/stamps', {
    token: tokens.ops,
    body: {
      stampNumber: `DEMO-${Date.now()}`,
      denomination: 100,
      stateCode: 'IN-OR',
      vendor: 'Treasury, Bhubaneswar',
      scanBase64: stampScan,
    },
  });
  ok(`stamp registered, scan hashed ${stamp.documentHash.slice(0, 16)}…`);

  step('3. Agent creates the agreement (FR-002)');
  const types = await call('GET', '/api/v1/templates/types', { token: tokens.agent });
  const type = types.find((t: { code: string }) => t.code === 'SVCAGR') ?? types[0];
  const templates = await call('GET', `/api/v1/templates?agreementTypeId=${type.id}`, { token: tokens.agent });
  const versions = await call('GET', `/api/v1/templates/${templates[0].id}/versions`, { token: tokens.agent });
  const approved = versions.find((v: { status: string }) => v.status === 'APPROVED');

  const agreement = await call('POST', '/api/v1/agreements', {
    token: tokens.agent,
    expect: 201,
    body: {
      agreementTypeId: type.id,
      templateVersionId: approved.id,
      placeOfExecutionState: 'IN-OR',
      data: {
        executionDate: new Date().toISOString().slice(0, 10),
        placeOfExecution: 'Bhubaneswar, Odisha',
        agentName: 'Ramesh Kumar',
        serviceDescription: 'community mobilisation and field survey services',
        termMonths: '12',
        startDate: new Date().toISOString().slice(0, 10),
        consideration: 'Rs. 4,50,000 (Rupees four lakh fifty thousand only)',
      },
      parties: [
        { partyType: 'AGENT', name: 'Ramesh Kumar', email: 'agent@gtids.example' },
        { partyType: 'EMPLOYEE', name: 'Sunita Patnaik', email: 'employee@gtids.example' },
        { partyType: 'MD', name: 'Dr. A. K. Mohanty', email: 'md@gtids.example' },
      ],
    },
  });
  const id: string = agreement.id;
  ok(`created ${c.cyan}${agreement.agreement_number}${c.reset} in ${agreement.status}`);

  step('4. Allocate the stamp and generate the document (FR-006, FR-009)');
  await call('POST', `/api/v1/agreements/${id}/stamp`, {
    token: tokens.agent,
    body: { stampId: stamp.id },
    expect: 201,
  });
  const generated = await call('POST', `/api/v1/agreements/${id}/generate`, {
    token: tokens.agent,
    expect: 201,
  });
  ok(`document generated, three signature widgets reserved — ${generated.documentHash.slice(0, 16)}…`);

  step('5. The sequence is enforced before anyone signs');
  const earlyApproval = await fetch(`${API}/api/v1/agreements/${id}/employee-approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.employee}` },
    body: JSON.stringify({ documentHash: generated.documentHash }),
  });
  const earlyBody = await earlyApproval.json();
  check(earlyApproval.status === 409, `employee approval refused before the agent signs — ${earlyBody.error?.rule} (BR-002)`);

  const earlyMd = await fetch(`${API}/api/v1/agreements/${id}/sign/md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.md}` },
    body: JSON.stringify({ documentHash: generated.documentHash }),
  });
  check((await earlyMd.json()) && earlyMd.status === 409, 'MD signature refused before approval (BR-003)');

  step('6. Agent signs (FR-011)');
  const agentHash = (await call('GET', `/api/v1/agreements/${id}/document`, { token: tokens.agent })).documentHash;
  const agentSign = await call('POST', `/api/v1/agreements/${id}/sign/agent`, {
    token: tokens.agent,
    body: { documentHash: agentHash },
    expect: 201,
  });
  info(`ceremony: ${agentSign.ceremonyUrl}`);
  info(`digest sent to the provider: ${agentSign.byteRangeDigest.slice(0, 32)}… (the document itself never leaves)`);
  await call('POST', new URL(agentSign.ceremonyUrl).pathname + '/complete');

  const afterAgent = await call('GET', `/api/v1/agreements/${id}/verify-signatures`, { token: tokens.agent });
  check(afterAgent.count === 1 && afterAgent.allValid, 'agent signature applied and valid');
  check(
    (await call('GET', `/api/v1/agreements/${id}`, { token: tokens.agent })).status === 'PENDING_EMPLOYEE_APPROVAL',
    'advanced to PENDING_EMPLOYEE_APPROVAL',
  );

  step('7. Employee approves (FR-012 — attested, not an eSign signature)');
  const employeeHash = (await call('GET', `/api/v1/agreements/${id}/document`, { token: tokens.employee })).documentHash;

  const stale = await fetch(`${API}/api/v1/agreements/${id}/employee-approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.employee}` },
    body: JSON.stringify({ documentHash: generated.documentHash }),
  });
  check((await stale.json()).error?.code === 'STALE_DOCUMENT', 'a stale document hash is refused (FR-027)');

  await call('POST', `/api/v1/agreements/${id}/employee-approve`, {
    token: tokens.employee,
    body: { documentHash: employeeHash },
    expect: 201,
  });
  const afterEmployee = await call('GET', `/api/v1/agreements/${id}/verify-signatures`, { token: tokens.employee });
  check(afterEmployee.allValid, 'agent signature STILL valid after the attestation was appended');

  step('8. MD signs (FR-013)');
  const mdHash = (await call('GET', `/api/v1/agreements/${id}/document`, { token: tokens.md })).documentHash;
  const mdSign = await call('POST', `/api/v1/agreements/${id}/sign/md`, {
    token: tokens.md,
    body: { documentHash: mdHash },
    expect: 201,
  });
  await call('POST', new URL(mdSign.ceremonyUrl).pathname + '/complete');

  step('9. Completion (FR-016, BR-007)');
  const final = await call('GET', `/api/v1/agreements/${id}`, { token: tokens.md });
  check(final.status === 'COMPLETED', 'agreement is COMPLETED');
  check(!!final.completed_at, 'completion timestamp recorded');
  check(final.stamp !== null, 'stamp remains attached to the record');

  const report = await call('GET', `/api/v1/agreements/${id}/verify-signatures`, { token: tokens.md });
  check(report.count === 2 && report.allValid, `AC-10 — both signatures valid on the final document`);
  for (const s of report.signatures) {
    info(`signature ${s.index}: ${s.signerCommonName} — covers ${s.coversBytes.toLocaleString()} bytes` +
      (s.coversWholeFile ? ' (whole file)' : ' (prefix; later revisions appended)'));
  }

  step('10. Notifications to all three parties (FR-018, BR-008)');
  const notifications = await call('GET', '/api/v1/reports/notifications', { token: tokens.auditor });
  const completed = notifications.filter((n: { event_type: string }) => n.event_type === 'COMPLETED');
  const total = completed.reduce((sum: number, n: { count: string }) => sum + Number(n.count), 0);
  check(total >= 3, `${total} completion notification recipients recorded (agent, employee, MD)`);
  info(completed.map((n: any) => `${n.status}: ${n.count}`).join(', ') || 'none yet — the worker dispatches within 30s');

  step('11. Audit trail and chain integrity (FR-017, FR-025)');
  const audit = await call('GET', `/api/v1/agreements/${id}/audit`, { token: tokens.auditor });
  const events: string[] = audit.entries.map((e: { event_type: string }) => e.event_type);
  for (const required of ['AGREEMENT_CREATED', 'STAMP_ALLOCATED', 'AGREEMENT_GENERATED',
    'AGENT_SIGNED', 'EMPLOYEE_APPROVED', 'MD_SIGNED', 'AGREEMENT_COMPLETED']) {
    check(events.includes(required), `audit records ${required}`);
  }
  check(audit.chain.intact, `hash chain intact across ${audit.chain.recordCount} records`);

  step('12. Public verification (FR-019, BR-010)');
  const qr = await call('GET', `/api/v1/agreements/${id}/qr`, { token: tokens.agent });
  const token = qr.url.split('/').pop();
  const verified = await call('GET', `/api/v1/verify/${token}`);
  check(verified.found && verified.status === 'COMPLETED', 'QR token resolves to the completed agreement');
  const exposed = JSON.stringify(verified);
  check(!exposed.includes('Ramesh Kumar') && !exposed.includes('@gtids.example'),
    'no party names or emails exposed publicly');

  const byNumber = await call('GET', `/api/v1/verify/${encodeURIComponent(final.agreement_number)}`);
  check(byNumber.found === false, 'the agreement number cannot be used to enumerate the register (AC-17)');

  step('13. The completed agreement is frozen (BR-005)');
  const edit = await fetch(`${API}/api/v1/agreements/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.agent}` },
    body: JSON.stringify({ data: { consideration: 'Rs. 1' } }),
  });
  check(edit.status === 409, 'content edits are refused after completion');

  step('14. Save the final signed PDF');
  const download = await call('GET', `/api/v1/agreements/${id}/document`, { token: tokens.agent });
  const pdf = Buffer.from(await (await fetch(download.url)).arrayBuffer());
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${final.agreement_number.replace(/\//g, '-')}.pdf`);
  await fs.writeFile(file, pdf);
  check(pdf.subarray(0, 5).toString() === '%PDF-', `written to ${path.relative(process.cwd(), file)} (${pdf.length.toLocaleString()} bytes)`);

  console.log(
    failures === 0
      ? `\n${c.green}${c.bold}DEMONSTRATION PASSED${c.reset} — ${final.agreement_number} executed end to end.\n` +
        `Open ${path.relative(process.cwd(), file)} in Adobe Acrobat Reader to complete AC-10 sign-off.\n` +
        `Verify publicly at ${qr.url}\n`
      : `\n${c.red}${c.bold}DEMONSTRATION FAILED${c.reset} — ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n${c.red}Demonstration aborted:${c.reset}`, (e as Error).message);
  process.exit(1);
});
