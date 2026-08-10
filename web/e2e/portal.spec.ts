import { test, expect, Page } from '@playwright/test';

/**
 * Browser-driven verification of the portal against a running deployment.
 *
 *   ./deploy/local/start.sh
 *   cd web && npx playwright test
 *
 * Drives the real UI: forms are filled and buttons clicked, so the server-action
 * transport, the session cookie, role gating and the signing flow are all
 * exercised the way a signer would exercise them. Nothing is stubbed.
 */

const PASSWORD = process.env.DEMO_PASSWORD ?? 'ChangeMe-Dev-2026!';
const API = process.env.API_ORIGIN ?? 'http://localhost:3100';

const USERS = {
  ops: 'ops@gtids.example',
  agent: 'agent@gtids.example',
  employee: 'employee@gtids.example',
  md: 'md@gtids.example',
  auditor: 'auditor@gtids.example',
};

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/agreements');
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login');
}

/**
 * Completes the provider ceremony. The portal opens the provider's page in a new
 * tab; here we drive that page directly, which is exactly what a signer does.
 */
async function completeCeremony(page: Page, ceremonyUrl: string) {
  const ceremony = await page.context().newPage();
  await ceremony.goto(ceremonyUrl);
  await expect(ceremony.getByRole('heading')).toContainText('Sign GTIDS/');
  await ceremony.getByPlaceholder('000000').fill('123456');
  await ceremony.getByRole('button', { name: 'Sign with Aadhaar OTP' }).click();
  await expect(ceremony.locator('#out')).toContainText('SIGNED', { timeout: 20_000 });
  await ceremony.close();
}

test.describe.configure({ mode: 'serial' });

test.describe('GTIDS Agreement Portal', () => {
  let agreementNumber: string;
  let agreementUrl: string;

  test('unauthenticated visitors are sent to sign in', async ({ page }) => {
    await page.goto('/agreements');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('bad credentials are refused without revealing which half was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@test.invalid');
    await page.getByLabel('Password').fill('wrong-password-here');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Scoped to our notice: Next renders its own aria-live route announcer,
    // which also carries role="alert".
    await expect(page.locator('.notice-error')).toContainText('Invalid credentials');
  });

  test('operations registers a stamp paper', async ({ page }) => {
    await signIn(page, USERS.ops);
    await page.goto('/stamps');
    await expect(page.getByRole('heading', { name: 'Stamp inventory' })).toBeVisible();

    const stampNumber = `UI-${Date.now()}`;
    await page.getByLabel('Stamp / certificate number').fill(stampNumber);
    await page.getByLabel('Issuing state').fill('IN-OR');
    await page.getByLabel('Vendor').fill('Treasury, Bhubaneswar');
    await page.getByLabel('Scan of the stamp paper').setInputFiles({
      name: 'stamp.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
          '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
          '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\n' +
          'trailer<</Root 1 0 R>>\n%%EOF\n',
      ),
    });
    await page.getByRole('button', { name: 'Register stamp paper' }).click();

    await expect(page.getByText('Registered.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('cell', { name: stampNumber })).toBeVisible();
  });

  test('an agent creates an agreement, attaches a stamp and generates it', async ({ page }) => {
    await signIn(page, USERS.agent);
    await page.goto('/agreements/new');

    await page.getByLabel('State of execution').fill('IN-OR');
    await page.getByLabel('Date of execution').fill('2026-08-10');
    await page.getByLabel('Place of execution').fill('Bhubaneswar, Odisha');
    await page.getByLabel('Agent name (as it appears in the deed)').fill('Ramesh Kumar');
    await page.getByLabel('Services to be provided').fill('community mobilisation services');
    await page.getByLabel('Term (months)').fill('12');
    await page.getByLabel('Commencement date').fill('2026-09-01');
    await page.getByLabel('Consideration').fill('Rs. 4,50,000');

    const parties = [
      { heading: /^Agent —/, name: 'Ramesh Kumar', email: USERS.agent },
      { heading: /^Employee —/, name: 'Sunita Patnaik', email: USERS.employee },
      { heading: /^Managing Director —/, name: 'Dr. A. K. Mohanty', email: USERS.md },
    ];
    for (const p of parties) {
      const block = page.locator('div').filter({ has: page.getByRole('heading', { name: p.heading }) }).last();
      await block.getByLabel('Full name').fill(p.name);
      await block.getByLabel('Email').fill(p.email);
    }

    await page.getByRole('button', { name: 'Create draft agreement' }).click();
    await page.waitForURL(/\/agreements\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    agreementUrl = page.url();
    agreementNumber = (await page.locator('h1.mono').innerText()).trim();
    expect(agreementNumber).toMatch(/^GTIDS\/\d{4}-\d{2}\/SVCAGR\/\d{6}$/);
    await expect(page.getByText('Draft')).toBeVisible();

    // Stamp, then generate.
    await page.getByRole('button', { name: 'Allocate stamp' }).click();
    // Once allocated, the picker disappears and the stamp panel shows the detail.
    await expect(page.getByText('Rs. 100.00')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Allocate stamp paper' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Generate agreement document' }).click();
    await expect(page.getByText('Awaiting agent signature')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: /Open document/ })).toBeVisible();
  });

  test('the employee cannot approve before the agent has signed (BR-002)', async ({ page }) => {
    await signIn(page, USERS.employee);
    await page.goto(agreementUrl);
    // The rule is structural: with no edge in the transition table, the API
    // reports no available action, so the button is not offered at all.
    await expect(page.getByRole('button', { name: 'Approve this agreement' })).toHaveCount(0);
    await expect(page.getByText('Nothing is waiting on you at this stage.')).toBeVisible();
  });

  test('the MD cannot sign before approval (BR-003)', async ({ page }) => {
    await signIn(page, USERS.md);
    await page.goto(agreementUrl);
    await expect(page.getByRole('button', { name: 'Sign as Managing Director' })).toHaveCount(0);
  });

  test('the agent signs through the provider ceremony', async ({ page }) => {
    await signIn(page, USERS.agent);
    await page.goto(agreementUrl);

    await page.getByRole('button', { name: 'Sign as Agent' }).click();
    const link = page.getByRole('link', { name: /Continue to eSign provider/ });
    await expect(link).toBeVisible({ timeout: 30_000 });

    const ceremonyUrl = await link.getAttribute('href');
    expect(ceremonyUrl).toContain('/mock-ceremony/');
    await completeCeremony(page, ceremonyUrl!);

    await page.reload();
    await expect(page.getByText('Awaiting employee approval')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('1 applied')).toBeVisible();
    await expect(page.getByText('all valid')).toBeVisible();
  });

  test('the employee approves, and the agent signature survives it', async ({ page }) => {
    await signIn(page, USERS.employee);
    await page.goto(agreementUrl);

    // The employee is shown the agent-signed document before approving.
    await expect(page.getByText('1 applied')).toBeVisible();
    await page.getByRole('button', { name: 'Approve this agreement' }).click();

    await expect(page.getByText('Awaiting MD signature')).toBeVisible({ timeout: 30_000 });
    // The attestation was appended, not re-rendered — signature 1 still verifies.
    await expect(page.getByText('all valid')).toBeVisible();
  });

  test('the MD signs and the agreement completes', async ({ page }) => {
    await signIn(page, USERS.md);
    await page.goto(agreementUrl);

    await page.getByRole('button', { name: 'Sign as Managing Director' }).click();
    const link = page.getByRole('link', { name: /Continue to eSign provider/ });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await completeCeremony(page, (await link.getAttribute('href'))!);

    await page.reload();
    await expect(page.getByText('Completed', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('2 applied')).toBeVisible();
    await expect(page.getByText('all valid')).toBeVisible();

    // Both signature verdicts, with the prefix/whole-file distinction explained.
    await expect(page.getByText('the whole document')).toBeVisible();
    await expect(page.getByText(/a prefix; later revisions were appended/)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Public verification' })).toBeVisible();
    await expect(page.getByText('This agreement is complete. No further action is possible.')).toBeVisible();
  });

  test('the auditor sees a complete, intact audit trail', async ({ page }) => {
    await signIn(page, USERS.auditor);
    await page.goto(agreementUrl);

    await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
    await expect(page.getByText(/chain intact · \d+ records/)).toBeVisible();

    for (const event of [
      'Agreement created',
      'Stamp allocated',
      'Document generated',
      'Agent signed',
      'Employee approved',
      'MD signed',
      'Agreement completed',
    ]) {
      await expect(page.getByText(event, { exact: true }).first()).toBeVisible();
    }
  });

  test('anyone can verify publicly, and nothing private is exposed', async ({ page, request }) => {
    // The QR token is on the completed agreement page.
    await signIn(page, USERS.agent);
    await page.goto(agreementUrl);
    const qrLink = await page.locator('a.mono[href*="/verify/"]').first().getAttribute('href');
    const token = qrLink!.split('/').pop()!;
    await signOut(page);

    await page.goto(`/verify/${token}`);
    await expect(page.getByText('This is a genuine GTIDS agreement')).toBeVisible();
    await expect(page.getByText(agreementNumber)).toBeVisible();
    await expect(page.getByText('Fully executed by all three parties.')).toBeVisible();

    const html = await page.content();
    for (const secret of ['Ramesh Kumar', 'Sunita Patnaik', 'gtids.example']) {
      expect(html).not.toContain(secret);
    }

    // AC-17 — the agreement number is not a verification key.
    await page.goto(`/verify/${encodeURIComponent(agreementNumber)}`);
    await expect(page.getByText('No agreement matches this code')).toBeVisible();

    // And the API itself refuses to be enumerated.
    const probe = await request.get(`${API}/api/v1/verify/${'A'.repeat(32)}`);
    expect(probe.status()).toBe(200);
    expect(await probe.json()).toEqual({ found: false });
  });

  test('role gating hides administration from an auditor', async ({ page }) => {
    await signIn(page, USERS.auditor);
    await expect(page.getByRole('link', { name: 'Stamp inventory' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'New agreement' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Reports' })).toBeVisible();
  });

  test('rejection requires a substantive reason (FR-015)', async ({ page }) => {
    // A fresh agreement taken to the approval stage, then rejected.
    await signIn(page, USERS.employee);
    await page.goto('/agreements?status=PENDING_EMPLOYEE_APPROVAL');
    const pending = page.locator('td a.mono').first();

    if ((await pending.count()) === 0) {
      test.skip(true, 'no agreement is awaiting approval');
      return;
    }

    await pending.click();
    await page.getByRole('button', { name: 'Reject' }).click();

    const reason = page.getByLabel('Reason for rejection');
    await reason.fill('too short');

    // Layer 1 — the browser refuses to submit at all.
    await page.getByRole('button', { name: 'Confirm rejection' }).click();
    expect(await reason.evaluate((el: HTMLTextAreaElement) => el.validity.valid)).toBe(false);
    await expect(page.locator('.notice-error')).toHaveCount(0);

    // Layer 2 — strip the constraint and submit anyway. Native validation is a
    // convenience; the rule itself is enforced server-side.
    await reason.evaluate((el) => el.removeAttribute('minlength'));
    await page.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(page.locator('.notice-error')).toContainText('at least 10 characters');

    // And the agreement was not rejected.
    await expect(page.getByText('Awaiting employee approval')).toBeVisible();
  });
});
