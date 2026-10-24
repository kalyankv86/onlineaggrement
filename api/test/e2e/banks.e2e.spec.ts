import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Knex } from 'knex';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createTestApp, seedFixtures, resetData, type SeededFixtures } from '../helpers/test-app';

jest.setTimeout(180_000);

/**
 * Multi-bank operation (DEC-031, DEC-032, DEC-034).
 *
 * The rules worth testing here are the ones that stop an agent executing
 * something other than what GTIDS agreed with their bank.
 */
describe('Banks and per-bank agreements', () => {
  let app: INestApplication;
  let http: request.SuperTest<request.Test>;
  let knex: Knex;
  let fixtures: SeededFixtures;
  let close: () => Promise<void>;
  let tokens: Record<string, string>;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  async function bankAgreementPdf(text: string): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText(text, { x: 60, y: 760, size: 12, font });
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }

  beforeAll(async () => {
    ({ app, knex, close } = await createTestApp());
    http = request(app.getHttpServer()) as unknown as request.SuperTest<request.Test>;
    fixtures = await seedFixtures(knex);

    tokens = {};
    for (const who of ['admin', 'ops', 'agent', 'employee', 'md', 'auditor']) {
      const res = await http
        .post('/api/v1/auth/login')
        .send({ email: fixtures.users[who].email, password: fixtures.password })
        .expect(200);
      tokens[who] = res.body.accessToken;
    }
  });

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    // resetData truncates banks and their documents, and detaches every user
    // from a bank, so nothing here leaks into another suite.
    await resetData(knex);
  });

  async function createBank(code = 'UBI', name = 'Union Bank of India') {
    const res = await http
      .post('/api/v1/banks')
      .set(auth('ops'))
      .send({ code, name, contactEmail: 'rm@ubi.test' })
      .expect(201);
    return res.body;
  }

  describe('DEC-031 — banks and who may administer them', () => {
    it('creates a bank and reports it with no active document', async () => {
      const bank = await createBank();
      expect(bank.code).toBe('UBI');

      const list = await http.get('/api/v1/banks').set(auth('ops')).expect(200);
      const row = list.body.find((b: { id: string }) => b.id === bank.id);
      expect(row.has_active_document).toBe(false);
      expect(row.agent_count).toBe(0);
    });

    it('refuses the same institution entered in a different case', async () => {
      await createBank();
      // Two records for one bank would split its agents and its agreement text,
      // and nothing downstream would report the split as a fault.
      const res = await http
        .post('/api/v1/banks')
        .set(auth('ops'))
        .send({ code: 'ubi-2', name: 'union bank of india' })
        .expect(409);
      expect(res.body.error.message).toMatch(/already exists/i);
    });

    it('does not let an agent create or alter a bank', async () => {
      await http.post('/api/v1/banks').set(auth('agent')).send({ code: 'X', name: 'X' }).expect(403);
      const bank = await createBank();
      await http.patch(`/api/v1/banks/${bank.id}`).set(auth('agent')).send({ name: 'Mine' }).expect(403);
    });
  });

  describe('DEC-034 — designating the employee who countersigns', () => {
    it('accepts internal staff holding the Employee role', async () => {
      const bank = await createBank();
      const eligible = await http.get('/api/v1/banks/eligible-signers').set(auth('ops')).expect(200);
      expect(eligible.body.map((u: { email: string }) => u.email)).toContain(
        fixtures.users.employee.email,
      );

      const updated = await http
        .patch(`/api/v1/banks/${bank.id}`)
        .set(auth('ops'))
        .send({ employeeSignerUserId: fixtures.users.employee.id })
        .expect(200);
      expect(updated.body.employee_signer_user_id).toBe(fixtures.users.employee.id);
    });

    it('refuses an agent as the countersigner', async () => {
      const bank = await createBank();
      await knex('users').where('id', fixtures.users.agent.id).update({ bank_id: bank.id });

      /*
       * Both signatures would otherwise sit on the same side of the agreement.
       * The check is on bank membership, not on the role name, because that is
       * what actually makes someone a counterparty.
       */
      const res = await http
        .patch(`/api/v1/banks/${bank.id}`)
        .set(auth('ops'))
        .send({ employeeSignerUserId: fixtures.users.agent.id })
        .expect(422);
      expect(res.body.error.message).toMatch(/belongs to a bank/i);
    });

    it('refuses a user without the Employee role', async () => {
      const bank = await createBank();
      const res = await http
        .patch(`/api/v1/banks/${bank.id}`)
        .set(auth('ops'))
        .send({ employeeSignerUserId: fixtures.users.auditor.id })
        .expect(422);
      expect(res.body.error.message).toMatch(/Employee role/i);
    });
  });

  describe('DEC-032 — the bank owns the agreement text', () => {
    it('activates one document per bank, superseding the previous version', async () => {
      const bank = await createBank();

      const first = await http
        .post(`/api/v1/banks/${bank.id}/documents`)
        .set(auth('ops'))
        .send({
          documentBase64: (await bankAgreementPdf('UBI agreement v1')).toString('base64'),
          filename: 'ubi-agreement.pdf',
        })
        .expect(201);
      expect(first.body.version_no).toBe(1);
      expect(first.body.is_active).toBe(true);
      expect(first.body.page_count).toBe(1);

      const second = await http
        .post(`/api/v1/banks/${bank.id}/documents`)
        .set(auth('ops'))
        .send({
          documentBase64: (await bankAgreementPdf('UBI agreement v2')).toString('base64'),
          filename: 'ubi-agreement-rev2.pdf',
        })
        .expect(201);
      expect(second.body.version_no).toBe(2);

      // Exactly one active, enforced by a partial unique index — with two, which
      // text an agent executed would depend on row order.
      const active = await knex('bank_agreement_documents').where({
        bank_id: bank.id,
        is_active: true,
      });
      expect(active).toHaveLength(1);
      expect(active[0].version_no).toBe(2);

      // The superseded version is kept: it is what earlier agreements executed.
      const all = await http.get(`/api/v1/banks/${bank.id}/documents`).set(auth('ops')).expect(200);
      expect(all.body).toHaveLength(2);
    });
  });

  describe('an agent executes their own bank\'s agreement', () => {
    async function readyBank() {
      const bank = await createBank();
      await http
        .patch(`/api/v1/banks/${bank.id}`)
        .set(auth('ops'))
        .send({ employeeSignerUserId: fixtures.users.employee.id })
        .expect(200);
      await http
        .post(`/api/v1/banks/${bank.id}/documents`)
        .set(auth('ops'))
        .send({
          documentBase64: (await bankAgreementPdf('UBI standard agreement')).toString('base64'),
          filename: 'ubi-agreement.pdf',
        })
        .expect(201);
      await knex('users').where('id', fixtures.users.agent.id).update({ bank_id: bank.id });
      return bank;
    }

    async function createAgreement() {
      const res = await http
        .post('/api/v1/agreements')
        .set(auth('agent'))
        .send({
          agreementTypeId: fixtures.agreementTypeId,
          data: { agentName: 'Ramesh Kumar', consideration: 'Rs. 1,00,000' },
          parties: [
            { partyType: 'AGENT', name: 'Ramesh Kumar', email: fixtures.users.agent.email },
            { partyType: 'MD', name: 'Dr. A. K. Mohanty', email: fixtures.users.md.email },
          ],
        })
        .expect(201);
      return res.body;
    }

    it('records the bank and attaches the designated employee automatically', async () => {
      const bank = await readyBank();
      const agreement = await createAgreement();

      const row = await knex('agreements').where('id', agreement.id).first();
      expect(row.bank_id).toBe(bank.id);

      const employee = await knex('agreement_parties')
        .where({ agreement_id: agreement.id, party_type: 'EMPLOYEE' })
        .first();
      expect(employee.email).toBe(fixtures.users.employee.email);
    });

    it('composes from the bank document, with the stamp as page 1', async () => {
      await readyBank();
      const agreement = await createAgreement();

      const stamp = await http
        .post('/api/v1/stamps')
        .set(auth('ops'))
        .send({
          stampNumber: 'IN-AP-BANKTEST-0001',
          denomination: 100,
          stateCode: 'IN-AP',
          scanBase64: (await bankAgreementPdf('e-Stamp')).toString('base64'),
        })
        .expect(201);
      await http
        .post(`/api/v1/agreements/${agreement.id}/stamp`)
        .set(auth('agent'))
        .send({ stampId: stamp.body.id })
        .expect(201);

      const composed = await http
        .post(`/api/v1/agreements/${agreement.id}/compose`)
        .set(auth('agent'))
        .expect(201);

      // Stamp scan plus the bank's one-page agreement.
      expect(composed.body.pageCount).toBe(2);
      expect((await knex('agreements').where('id', agreement.id).first()).status).toBe(
        'READY_FOR_AGENT_SIGNATURE',
      );
    });

    it('refuses an agent uploading their own file for a bank agreement', async () => {
      await readyBank();
      const agreement = await createAgreement();

      /*
       * The point of DEC-032. If this were permitted, an agent could execute
       * wording GTIDS never agreed with the bank, and the signatures would be
       * just as valid.
       */
      const res = await http
        .post(`/api/v1/agreements/${agreement.id}/document`)
        .set(auth('agent'))
        .send({
          fileBase64: (await bankAgreementPdf('Terms I wrote myself')).toString('base64'),
          filename: 'my-own-terms.pdf',
        })
        .expect(422);
      expect(res.body.error.message).toMatch(/comes from the bank/i);
    });

    it('refuses creation when the bank has no designated signer', async () => {
      const bank = await createBank('SBI', 'State Bank of India');
      await knex('users').where('id', fixtures.users.agent.id).update({ bank_id: bank.id });

      const res = await http
        .post('/api/v1/agreements')
        .set(auth('agent'))
        .send({
          agreementTypeId: fixtures.agreementTypeId,
          data: {},
          parties: [
            { partyType: 'AGENT', name: 'Ramesh Kumar', email: fixtures.users.agent.email },
            { partyType: 'MD', name: 'Dr. A. K. Mohanty', email: fixtures.users.md.email },
          ],
        })
        .expect(422);
      // Named, so the administrator knows which bank to fix.
      expect(res.body.error.message).toMatch(/State Bank of India/);
    });

    it('will not let one bank\'s agent execute another bank\'s agreement', async () => {
      const mine = await readyBank();
      const theirs = await createBank('SBI', 'State Bank of India');

      const res = await http
        .post('/api/v1/agreements')
        .set(auth('agent'))
        .send({
          agreementTypeId: fixtures.agreementTypeId,
          bankId: theirs.id,
          data: {},
          parties: [
            { partyType: 'AGENT', name: 'Ramesh Kumar', email: fixtures.users.agent.email },
            { partyType: 'MD', name: 'Dr. A. K. Mohanty', email: fixtures.users.md.email },
          ],
        })
        .expect(403);
      expect(res.body.error.message).toMatch(/your own bank/i);
      expect(mine.id).not.toBe(theirs.id);
    });

    it('refuses an EMPLOYEE party supplied in the request', async () => {
      await readyBank();
      // Rejected at the DTO, since EMPLOYEE is not an accepted party type; the
      // service repeats the check as a backstop for a caller that bypasses it.
      const res = await http
        .post('/api/v1/agreements')
        .set(auth('agent'))
        .send({
          agreementTypeId: fixtures.agreementTypeId,
          data: {},
          parties: [
            { partyType: 'AGENT', name: 'Ramesh Kumar', email: fixtures.users.agent.email },
            { partyType: 'EMPLOYEE', name: 'A Friend', email: 'friend@example.test' },
            { partyType: 'MD', name: 'Dr. A. K. Mohanty', email: fixtures.users.md.email },
          ],
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/partyType/i);
    });
  });
});
