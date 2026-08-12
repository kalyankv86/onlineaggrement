import { INestApplication } from '@nestjs/common';
import { Knex } from 'knex';
import request from 'supertest';
import {
  createTestApp,
  resetData,
  seedFixtures,
  waitFor,
  SeededFixtures,
  SAMPLE_STAMP_SCAN_BASE64,
  buildSampleAgreements,
} from '../helpers/test-app';
import * as fixturesModule from '../helpers/test-app';
import { MockEsignProvider } from '../../src/esign/providers/mock.provider';
import { StorageDriver } from '../../src/documents/storage/storage.driver';
import { DocumentsService } from '../../src/documents/documents.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { AuditService } from '../../src/audit/audit.service';
import { reopenSignatureSlot } from '../../src/documents/pdf/incremental-signer';

jest.setTimeout(120_000);

/**
 * AC-01 … AC-22 exercised through the HTTP API, against real Postgres and the real
 * document pipeline. Only the ESP is a double, and it is a faithful one: hash-based
 * signing, HMAC-signed callbacks, real PKCS#7.
 */
describe('Agent → MD end to end (DEC-024)', () => {
  let app: INestApplication;
  let knex: Knex;
  let close: () => Promise<void>;
  let fixtures: SeededFixtures;
  let http: ReturnType<typeof request>;

  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    await buildSampleAgreements();
    ({ app, knex, close } = await createTestApp());
    http = request(app.getHttpServer());
  });

  afterAll(async () => close());

  beforeEach(async () => {
    await resetData(knex);
    fixtures = await seedFixtures(knex);
    for (const who of ['admin', 'ops', 'agent', 'employee', 'md', 'auditor']) {
      const res = await http
        .post('/api/v1/auth/login')
        .send({ email: fixtures.users[who].email, password: fixtures.password })
        .expect(200);
      tokens[who] = res.body.accessToken;
    }
  });

  /**
   * Stand in for the signer completing the Aadhaar OTP ceremony, then for the ESP
   * posting its callback.
   *
   * The test reads the parked document to obtain the bytes to sign — a real ESP
   * signs only the digest it was handed and never sees the document. That is why
   * the mock re-checks the digest before signing.
   */
  async function completeCeremony(transactionId: string, opts: { eventId?: string } = {}) {
    const tx = await knex('esign_transactions').where('id', transactionId).first();
    const storage = app.get(StorageDriver);
    const provider = app.get(MockEsignProvider);

    const parked = await storage.get(tx.pending_file_key);
    const slot = reopenSignatureSlot(parked);
    provider.completeCeremony(tx.provider_transaction_id, slot.signedContent, tx.byte_range_digest);

    const body = Buffer.from(
      JSON.stringify({ transactionId: tx.provider_transaction_id, status: 'SIGNED' }),
    );
    const headers = provider.signCallbackHeaders(body, opts.eventId);

    return http
      .post('/api/v1/esign/callback')
      .set(headers)
      .send(body.toString())
      .expect(200);
  }

  async function currentHash(agreementId: string): Promise<string> {
    const res = await http
      .get(`/api/v1/agreements/${agreementId}/document`)
      .set(auth('agent'))
      .expect(200);
    return res.body.documentHash;
  }

  async function setUpToGenerated() {
    const stamp = await http
      .post('/api/v1/stamps')
      .set(auth('ops'))
      .send({
        stampNumber: `ST-${Date.now()}`,
        denomination: 100,
        stateCode: 'IN-OR',
        scanBase64: SAMPLE_STAMP_SCAN_BASE64,
      })
      .expect(201);

    const agreement = await http
      .post('/api/v1/agreements')
      .set(auth('agent'))
      .send({
        agreementTypeId: fixtures.agreementTypeId,
        templateVersionId: fixtures.templateVersionId,
        placeOfExecutionState: 'IN-OR',
        data: { agentName: 'Ramesh Kumar', consideration: 'Rs. 50,000' },
        parties: [
          { partyType: 'AGENT', userId: fixtures.users.agent.id, name: 'Ramesh Kumar', email: fixtures.users.agent.email },
          { partyType: 'MD', userId: fixtures.users.md.id, name: 'Dr. A. K. Mohanty', email: fixtures.users.md.email },
        ],
      })
      .expect(201);

    const id = agreement.body.id;
    await http.post(`/api/v1/agreements/${id}/stamp`).set(auth('agent')).send({ stampId: stamp.body.id }).expect(201);

    // DEC-025 — GTIDS supplies the agreement; the portal composes it with the
    // stamp scan rather than generating it from a template.
    const uploaded = await http
      .post(`/api/v1/agreements/${id}/document`)
      .set(auth('agent'))
      .send({
        filename: 'service-agreement.pdf',
        contentType: 'application/pdf',
        fileBase64: fixturesModule.SAMPLE_AGREEMENT_BASE64,
      })
      .expect(201);

    return {
      id,
      stampId: stamp.body.id,
      documentHash: uploaded.body.documentHash,
      pageCount: uploaded.body.pageCount,
      number: agreement.body.agreement_number,
    };
  }

  describe('AC-01 — creation and generation', () => {
    it('produces a numbered agreement and a prepared document', async () => {
      const { id, number, documentHash } = await setUpToGenerated();

      expect(number).toMatch(/^GTIDS\/\d{4}-\d{2}\/TSTAGR\/\d{6}$/); // FR-026
      expect(documentHash).toHaveLength(64);

      const agreement = await http.get(`/api/v1/agreements/${id}`).set(auth('agent')).expect(200);
      expect(agreement.body.status).toBe('READY_FOR_AGENT_SIGNATURE');
      expect(agreement.body.parties).toHaveLength(3);
      expect(agreement.body.stamp.denomination).toBe('100.00');
      expect(agreement.body.expires_at).toBeTruthy(); // SLA clock started (FR-021)
    });

    it('refuses generation without a stamp when the type requires one', async () => {
      const agreement = await http
        .post('/api/v1/agreements')
        .set(auth('agent'))
        .send({
          agreementTypeId: fixtures.agreementTypeId,
          templateVersionId: fixtures.templateVersionId,
          data: { agentName: 'X', consideration: 'Y' },
          parties: [
            { partyType: 'AGENT', name: 'Agent Name', email: fixtures.users.agent.email },
            { partyType: 'MD', name: 'MD Name', email: fixtures.users.md.email },
          ],
        })
        .expect(201);

      const res = await http
        .post(`/api/v1/agreements/${agreement.body.id}/document`)
        .set(auth('agent'))
        .send({
          filename: 'a.pdf',
          contentType: 'application/pdf',
          fileBase64: fixturesModule.SAMPLE_AGREEMENT_BASE64,
        })
        .expect(422);
      expect(res.body.error.message).toMatch(/Allocate the stamp paper first/);
    });

    it('refuses a party set without both signers (DEC-024)', async () => {
      const res = await http
        .post('/api/v1/agreements')
        .set(auth('agent'))
        .send({
          agreementTypeId: fixtures.agreementTypeId,
          data: {},
          parties: [{ partyType: 'AGENT', name: 'Agent Name', email: fixtures.users.agent.email }],
        })
        .expect(422);
      expect(res.body.error.message).toMatch(/requires a MD party/);
    });

    it('attaches Accounts automatically as a non-signing recipient (DEC-028)', async () => {
      const { id } = await setUpToGenerated();
      const agreement = await http.get(`/api/v1/agreements/${id}`).set(auth('agent')).expect(200);

      const accounts = agreement.body.parties.find(
        (p: { party_type: string }) => p.party_type === 'ACCOUNTS',
      );
      expect(accounts.email).toBe('accounts@test.gtids');

      // It signs nothing: no widget, no signature record, no eSign transaction.
      const report = await http
        .get(`/api/v1/agreements/${id}/verify-signatures`)
        .set(auth('agent'))
        .expect(200);
      expect(report.body.count).toBe(0);
    });
  });

  describe('AC-03 — the sequence is mandatory (DEC-024)', () => {
    it('MD cannot sign before the agent has signed (BR-003)', async () => {
      const { id, documentHash } = await setUpToGenerated();
      const res = await http
        .post(`/api/v1/agreements/${id}/sign/md`)
        .set(auth('md'))
        .send({ documentHash })
        .expect(409);
      expect(res.body.error.rule).toMatch(/BR-003/);
    });
  });

  describe('the complete happy path', () => {
    it('runs Agent → MD and ends COMPLETED with every guarantee intact', async () => {
      const { id, number } = await setUpToGenerated();

      // ── Agent signs (FR-011) ────────────────────────────────────────────────
      const initiate = await http
        .post(`/api/v1/agreements/${id}/sign/agent`)
        .set(auth('agent'))
        .send({ documentHash: await currentHash(id) })
        .expect(201);
      expect(initiate.body.ceremonyUrl).toBeTruthy();
      expect(initiate.body.byteRangeDigest).toHaveLength(64);

      await completeCeremony(initiate.body.transactionId);
      await waitFor(
        async () =>
          (await knex('agreements').where('id', id).first()).status === 'PENDING_MD_SIGNATURE',
        { label: 'agent signature to land' },
      );

      const afterAgent = await http.get(`/api/v1/agreements/${id}/verify-signatures`).set(auth('agent')).expect(200);
      expect(afterAgent.body.count).toBe(1);
      expect(afterAgent.body.allValid).toBe(true);

      // No eSign transaction is consumed by anyone but the two signers.
      const midCount = await knex('esign_transactions').where('agreement_id', id).count<{ count: string }[]>('* as count');
      expect(Number(midCount[0].count)).toBe(1);

      // ── MD signs (FR-013) ───────────────────────────────────────────────────
      const mdInitiate = await http
        .post(`/api/v1/agreements/${id}/sign/md`)
        .set(auth('md'))
        .send({ documentHash: await currentHash(id) })
        .expect(201);

      await completeCeremony(mdInitiate.body.transactionId);
      await waitFor(
        async () => (await knex('agreements').where('id', id).first()).status === 'COMPLETED',
        { label: 'completion' },
      );

      // ── AC-05, AC-10 ────────────────────────────────────────────────────────
      const agreement = await knex('agreements').where('id', id).first();
      expect(agreement.completed_at).toBeTruthy();
      expect(agreement.verification_token).toHaveLength(32);

      const finalReport = await http.get(`/api/v1/agreements/${id}/verify-signatures`).set(auth('md')).expect(200);
      expect(finalReport.body.count).toBe(2);
      expect(finalReport.body.allValid).toBe(true);
      expect(finalReport.body.signatureState).toBe('FINAL');
      // The agent's signature covers a prefix; the MD's covers the whole file.
      expect(finalReport.body.signatures[0].coversWholeFile).toBe(false);
      expect(finalReport.body.signatures[1].coversWholeFile).toBe(true);

      // ── AC-06 — the final document is retrievable ───────────────────────────
      const doc = await http.get(`/api/v1/agreements/${id}/document`).set(auth('agent')).expect(200);
      expect(doc.body.url).toContain('/api/v1/documents/download');
      const downloaded = await http.get(doc.body.url.replace(/^https?:\/\/[^/]+/, '')).expect(200);
      expect(downloaded.body.subarray(0, 5).toString()).toBe('%PDF-');

      // ── AC-07 — one completion mail per party, three in total ───────────────
      const recipients = await knex('notification_recipients')
        .join('notifications', 'notifications.id', 'notification_recipients.notification_id')
        .where({ 'notifications.agreement_id': id, 'notifications.event_type': 'COMPLETED' })
        .select('notification_recipients.email', 'notification_recipients.status');
      // DEC-028 — the executing party, the MD, and Accounts.
      expect(recipients).toHaveLength(3);
      expect(recipients.map((r) => r.email).sort()).toEqual(
        ['accounts@test.gtids', fixtures.users.agent.email, fixtures.users.md.email].sort(),
      );
      expect(recipients.every((r) => r.status === 'QUEUED')).toBe(true); // dispatch is post-commit

      const { sent } = await app.get(NotificationsService).dispatchPending();
      expect(sent).toBeGreaterThanOrEqual(3);
      const delivered = await knex('notification_recipients')
        .join('notifications', 'notifications.id', 'notification_recipients.notification_id')
        .where({ 'notifications.agreement_id': id, 'notifications.event_type': 'COMPLETED' });
      expect(delivered.every((r) => r.status === 'SENT')).toBe(true);

      // ── BR-006 — the stamp is consumed ──────────────────────────────────────
      const stamp = await knex('stamp_papers')
        .join('stamp_allocations', 'stamp_allocations.stamp_paper_id', 'stamp_papers.id')
        .where('stamp_allocations.agreement_id', id)
        .select('stamp_papers.status')
        .first();
      expect(stamp.status).toBe('USED');

      // ── AC-08 — the audit trail is complete and its chain is intact ─────────
      const auditRes = await http.get(`/api/v1/agreements/${id}/audit`).set(auth('auditor')).expect(200);
      const events = auditRes.body.entries.map((e: { event_type: string }) => e.event_type);
      for (const required of [
        'AGREEMENT_CREATED', 'STAMP_ALLOCATED', 'AGREEMENT_GENERATED',
        'AGENT_SIGN_INITIATED', 'AGENT_SIGNED',
        'MD_SIGN_INITIATED', 'MD_SIGNED', 'AGREEMENT_COMPLETED',
        'FINAL_DOCUMENT_GENERATED',
      ]) {
        expect(events).toContain(required);
      }
      expect(auditRes.body.chain.intact).toBe(true);

      // ── AC-09 / BR-010 — public verification exposes nothing sensitive ──────
      const verify = await http.get(`/api/v1/verify/${agreement.verification_token}`).expect(200);
      expect(verify.body.found).toBe(true);
      expect(verify.body.agreementNumber).toBe(number);
      expect(verify.body.status).toBe('COMPLETED');
      expect(verify.body.documentHash).toHaveLength(64);
      const asText = JSON.stringify(verify.body);
      expect(asText).not.toContain('Ramesh Kumar');
      expect(asText).not.toContain(fixtures.users.agent.email);
      expect(asText).not.toMatch(/stamp/i);

      // ── AC-17 — the agreement number is not a verification key ──────────────
      const byNumber = await http.get(`/api/v1/verify/${encodeURIComponent(number)}`).expect(200);
      expect(byNumber.body.found).toBe(false);

      // ── AC-05 — content is frozen after completion ──────────────────────────
      await expect(
        knex('agreements').where('id', id).update({ data: { tampered: true } }),
      ).rejects.toThrow(/BR-005/);
    });
  });

  describe('AC-18 / FR-027 — stale-view protection', () => {
    it('refuses a signature carrying a hash the actor no longer sees', async () => {
      const { id, documentHash: hashAtGeneration } = await setUpToGenerated();

      const initiate = await http
        .post(`/api/v1/agreements/${id}/sign/agent`)
        .set(auth('agent'))
        .send({ documentHash: hashAtGeneration })
        .expect(201);
      await completeCeremony(initiate.body.transactionId);
      await waitFor(
        async () =>
          (await knex('agreements').where('id', id).first()).status === 'PENDING_MD_SIGNATURE',
        { label: 'agent signature' },
      );

      // The document has changed since it was composed — it now carries the
      // agent's signature, so the MD must act on the new bytes.
      const res = await http
        .post(`/api/v1/agreements/${id}/sign/md`)
        .set(auth('md'))
        .send({ documentHash: hashAtGeneration })
        .expect(409);

      expect(res.body.error.code).toBe('STALE_DOCUMENT');
      expect(res.body.error.rule).toBe('FR-027');
    });
  });

  describe('AC-13 — callback idempotency and authentication', () => {
    it('a duplicated callback produces no second transition', async () => {
      const { id } = await setUpToGenerated();
      const initiate = await http
        .post(`/api/v1/agreements/${id}/sign/agent`)
        .set(auth('agent'))
        .send({ documentHash: await currentHash(id) })
        .expect(201);

      const eventId = 'evt-replay-me';
      const first = await completeCeremony(initiate.body.transactionId, { eventId });
      expect(first.body.outcome).toBe('APPLIED');

      await waitFor(
        async () =>
          (await knex('agreements').where('id', id).first()).status === 'PENDING_MD_SIGNATURE',
        { label: 'first callback' },
      );
      const transitionsAfterFirst = await knex('workflow_transitions').where('agreement_id', id);

      const replay = await completeCeremony(initiate.body.transactionId, { eventId });
      expect(replay.body.outcome).toBe('DUPLICATE');

      const transitionsAfterReplay = await knex('workflow_transitions').where('agreement_id', id);
      expect(transitionsAfterReplay).toHaveLength(transitionsAfterFirst.length);
      expect((await knex('agreements').where('id', id).first()).status).toBe(
        'PENDING_MD_SIGNATURE',
      );
    });

    it('rejects a callback with a forged signature', async () => {
      const body = JSON.stringify({ transactionId: 'MOCK-forged', status: 'SIGNED' });
      const res = await http
        .post('/api/v1/esign/callback')
        .set({
          'x-gtids-signature': 'deadbeef'.repeat(8),
          'x-gtids-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-gtids-event-id': 'evt-forged',
        })
        .send(body)
        .expect(200);

      expect(res.body.outcome).toBe('REJECTED_SIGNATURE');
      const recorded = await knex('esign_callback_events').where('signature_valid', false);
      expect(recorded.length).toBeGreaterThan(0);
    });

    it('rejects a replayed signature outside the timestamp window', async () => {
      const provider = app.get(MockEsignProvider);
      const body = Buffer.from(JSON.stringify({ transactionId: 'MOCK-old', status: 'SIGNED' }));
      const headers = provider.signCallbackHeaders(body);
      headers['x-gtids-timestamp'] = String(Math.floor(Date.now() / 1000) - 3600);

      const res = await http.post('/api/v1/esign/callback').set(headers).send(body.toString()).expect(200);
      expect(res.body.outcome).toBe('REJECTED_SIGNATURE');
    });
  });

  describe('AC-12 / FR-015a — rejection and correction', () => {
    it('rejects, then opens version 2 preserving version 1 evidence', async () => {
      const { id } = await setUpToGenerated();
      const initiate = await http
        .post(`/api/v1/agreements/${id}/sign/agent`)
        .set(auth('agent'))
        .send({ documentHash: await currentHash(id) })
        .expect(201);
      await completeCeremony(initiate.body.transactionId);
      await waitFor(
        async () =>
          (await knex('agreements').where('id', id).first()).status === 'PENDING_MD_SIGNATURE',
        { label: 'agent signature' },
      );

      const v1Versions = await knex('agreement_versions').where('agreement_id', id);
      const v1Hashes = v1Versions.map((v) => v.document_hash);

      await http
        .post(`/api/v1/agreements/${id}/reject`)
        .set(auth('md'))
        .send({ reason: 'The consideration clause states the wrong amount' })
        .expect(201);

      const rejected = await knex('agreements').where('id', id).first();
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejected_reason).toMatch(/consideration clause/);

      await http.post(`/api/v1/agreements/${id}/correct`).set(auth('agent')).send().expect(201);

      const corrected = await knex('agreements').where('id', id).first();
      expect(corrected.status).toBe('DRAFT');
      expect(corrected.current_version).toBe(2);

      // Version 1's history is closed, and its documents are untouched.
      const history = await knex('agreement_version_history').where('agreement_id', id).first();
      expect(history.version_no).toBe(1);
      expect(history.status_at_close).toBe('REJECTED');
      expect(history.voided_signature_count).toBe(1);

      const stillThere = await knex('agreement_versions').where('agreement_id', id);
      expect(stillThere.map((v) => v.document_hash)).toEqual(expect.arrayContaining(v1Hashes));

      // FR-015b — the stamp stays with the agreement across the correction.
      const allocation = await knex('stamp_allocations')
        .where('agreement_id', id)
        .whereNull('released_at')
        .first();
      expect(allocation).toBeTruthy();

      // The point of a correction is to change something. With uploaded
      // agreements (DEC-025) that means supplying a revised document.
      const regenerated = await http
        .post(`/api/v1/agreements/${id}/document`)
        .set(auth('agent'))
        .send({
          filename: 'service-agreement-rev2.pdf',
          contentType: 'application/pdf',
          fileBase64: fixturesModule.SAMPLE_AGREEMENT_REV2_BASE64,
        })
        .expect(201);
      expect(regenerated.body.version).toBe(2);
      expect(v1Hashes).not.toContain(regenerated.body.documentHash);
    });

    it('refuses to replace the document once the agreement has left DRAFT (BR-005)', async () => {
      const { id } = await setUpToGenerated();
      const res = await http
        .post(`/api/v1/agreements/${id}/document`)
        .set(auth('agent'))
        .send({
          filename: 'substitute.pdf',
          contentType: 'application/pdf',
          fileBase64: fixturesModule.SAMPLE_AGREEMENT_REV2_BASE64,
        })
        .expect(409);
      expect(res.body.error.rule).toBe('BR-005');
    });

    it('refuses a rejection without a substantive reason', async () => {
      const { id } = await setUpToGenerated();
      await http
        .post(`/api/v1/agreements/${id}/reject`)
        .set(auth('md'))
        .send({ reason: 'no' })
        .expect(400);
    });
  });

  describe('AC-14 / FR-024 — reconciliation recovers a lost callback', () => {
    it('completes a signature the provider finished but never reported', async () => {
      const { id } = await setUpToGenerated();
      const initiate = await http
        .post(`/api/v1/agreements/${id}/sign/agent`)
        .set(auth('agent'))
        .send({ documentHash: await currentHash(id) })
        .expect(201);

      // Ceremony completes at the provider; the callback never arrives.
      const tx = await knex('esign_transactions').where('id', initiate.body.transactionId).first();
      const storage = app.get(StorageDriver);
      const provider = app.get(MockEsignProvider);
      const slot = reopenSignatureSlot(await storage.get(tx.pending_file_key));
      provider.completeCeremony(tx.provider_transaction_id, slot.signedContent, tx.byte_range_digest);

      expect((await knex('agreements').where('id', id).first()).status).toBe('AGENT_SIGNING');

      // Backdate so the job's "older than 60s" filter picks it up.
      await knex('esign_transactions')
        .where('id', tx.id)
        .update({ initiated_at: new Date(Date.now() - 120_000) });

      const { ScheduledJobsService } = await import('../../src/jobs/scheduled-jobs.service');
      const jobs = new ScheduledJobsService(
        knex,
        app.get(await import('../../src/esign/esign.service').then((m) => m.EsignService)),
        app.get(await import('../../src/signing/signing.service').then((m) => m.SigningService)),
        app.get(await import('../../src/workflow/workflow.service').then((m) => m.WorkflowService)),
        app.get(NotificationsService),
        app.get(AuditService),
        app.get(DocumentsService),
      );

      expect(await jobs.reconcileSigningTransactions()).toBe(1);
      expect((await knex('agreements').where('id', id).first()).status).toBe(
        'PENDING_MD_SIGNATURE',
      );
    });
  });

  describe('AC-19 / DEC-003 — external party access links', () => {
    it('is single-use, scoped to one agreement, and never stored in the clear', async () => {
      const { id } = await setUpToGenerated();
      const party = await knex('agreement_parties')
        .where({ agreement_id: id, party_type: 'AGENT' })
        .first();

      const issued = await http
        .post(`/api/v1/agreements/${id}/party-access`)
        .set(auth('ops'))
        .send({ partyId: party.id })
        .expect(201);

      const stored = await knex('party_access_tokens').where('agreement_id', id).first();
      expect(stored.token_hash).not.toBe(issued.body.token);
      expect(stored.token_hash).toHaveLength(64);

      const redeemed = await http
        .post('/api/v1/auth/party-access/redeem')
        .send({ token: issued.body.token })
        .expect(200);
      expect(redeemed.body.principal.scopedAgreementId).toBe(id);

      // Second redemption of the same link fails.
      await http
        .post('/api/v1/auth/party-access/redeem')
        .send({ token: issued.body.token })
        .expect(403);

      // The scoped session cannot reach a different agreement.
      const other = await setUpToGenerated();
      await http
        .get(`/api/v1/agreements/${other.id}`)
        .set({ Authorization: `Bearer ${redeemed.body.accessToken}` })
        .expect(403);
    });
  });

  describe('AC-20 / FR-021 — SLA expiry', () => {
    it('expires an agreement whose stage deadline has passed', async () => {
      const { id } = await setUpToGenerated();
      await knex('agreements')
        .where('id', id)
        .update({ expires_at: new Date(Date.now() - 86_400_000) });

      const { WorkflowService } = await import('../../src/workflow/workflow.service');
      const workflow = app.get(WorkflowService);
      const overdue = await workflow.findExpired();
      expect(overdue.map((a) => a.id)).toContain(id);

      await workflow.transition({
        agreementId: id,
        action: 'EXPIRE',
        actorId: null,
        actorRoles: ['SYSTEM'],
        trigger: 'SCHEDULER',
      });
      expect((await knex('agreements').where('id', id).first()).status).toBe('EXPIRED');
    });
  });

  describe('access control', () => {
    it('rejects an unauthenticated request', async () => {
      await http.get('/api/v1/agreements').expect(401);
    });

    it('rejects an invalid bearer token', async () => {
      await http.get('/api/v1/agreements').set({ Authorization: 'Bearer nonsense' }).expect(401);
    });

    it('does not let an auditor create an agreement', async () => {
      await http
        .post('/api/v1/agreements')
        .set(auth('auditor'))
        .send({
          agreementTypeId: fixtures.agreementTypeId,
          templateVersionId: fixtures.templateVersionId,
          data: {},
          parties: [],
        })
        .expect(403);
    });

    it('does not leak which half of the credentials was wrong', async () => {
      const unknownUser = await http
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@test.gtids', password: fixtures.password })
        .expect(403);
      const wrongPassword = await http
        .post('/api/v1/auth/login')
        .send({ email: fixtures.users.agent.email, password: 'wrong-password-entirely' })
        .expect(403);
      expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
    });
  });

  describe('AC-21 — sensitive data is absent from the database', () => {
    it('stores no OTP value or full Aadhaar number anywhere', async () => {
      const { id } = await setUpToGenerated();
      const initiate = await http
        .post(`/api/v1/agreements/${id}/sign/agent`)
        .set(auth('agent'))
        .send({ documentHash: await currentHash(id) })
        .expect(201);
      await completeCeremony(initiate.body.transactionId);

      const columns = await knex.raw(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name ILIKE '%otp%' OR column_name ILIKE '%aadhaar%')
      `);
      expect(columns.rows).toEqual([]);

      const transactions = await knex('esign_transactions').select('*');
      for (const tx of transactions) {
        expect(JSON.stringify(tx)).not.toMatch(/\b\d{12}\b/); // no bare Aadhaar-shaped number
      }
    });
  });
});
