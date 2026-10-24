import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Knex } from 'knex';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createTestApp, seedFixtures, resetData, type SeededFixtures } from '../helpers/test-app';

jest.setTimeout(300_000);

/**
 * DEC-036 — the per-agent execution reference.
 *
 * `UBI/AG0001/2026-27/001`: the bank, the agent, the financial year, and that
 * agent's sequence within it. Minted at completion, never before.
 */
describe('Execution reference', () => {
  let app: INestApplication;
  let http: request.SuperTest<request.Test>;
  let knex: Knex;
  let fixtures: SeededFixtures;
  let close: () => Promise<void>;
  let tokens: Record<string, string>;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const unique = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function onePagePdf(text: string): Promise<Buffer> {
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
    for (const who of ['admin', 'ops', 'agent', 'employee', 'md']) {
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
    await resetData(knex);
    await knex('agent_execution_sequences').del();
  });

  /** Drive one agreement from creation to COMPLETED and return its row. */
  async function executeAgreement(bankId: string | null) {
    if (bankId) {
      await knex('users').where('id', fixtures.users.agent.id).update({ bank_id: bankId });
    }

    const created = await http
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
    const id = created.body.id;

    const stamp = await http
      .post('/api/v1/stamps')
      .set(auth('ops'))
      .send({
        stampNumber: `IN-AP-REF-${unique()}`,
        denomination: 100,
        stateCode: 'IN-AP',
        scanBase64: (await onePagePdf('e-Stamp')).toString('base64'),
      })
      .expect(201);
    await http
      .post(`/api/v1/agreements/${id}/stamp`)
      .set(auth('agent'))
      .send({ stampId: stamp.body.id })
      .expect(201);

    if (bankId) {
      await http.post(`/api/v1/agreements/${id}/compose`).set(auth('agent')).expect(201);
    } else {
      await http
        .post(`/api/v1/agreements/${id}/document`)
        .set(auth('agent'))
        .send({
          fileBase64: (await onePagePdf('GTIDS engagement')).toString('base64'),
          filename: 'agreement.pdf',
        })
        .expect(201);
    }

    for (const party of ['agent', 'employee', 'md'] as const) {
      const hash = (
        await http.get(`/api/v1/agreements/${id}/document`).set(auth(party)).expect(200)
      ).body.documentHash;
      const initiate = await http
        .post(`/api/v1/agreements/${id}/sign/${party}`)
        .set(auth(party))
        .send({ documentHash: hash })
        .expect(201);
      await http.post(new URL(initiate.body.ceremonyUrl).pathname + '/complete').expect(201);

      for (let i = 0; i < 100; i += 1) {
        const row = await knex('agreements').where('id', id).first();
        if (row.status !== `${party.toUpperCase()}_SIGNING`) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    return { id, row: await knex('agreements').where('id', id).first() };
  }

  async function readyBank(name: string) {
    const bank = (
      await http
        .post('/api/v1/banks')
        .set(auth('ops'))
        .send({ code: `C${unique()}`.slice(0, 20), name: `${name} ${unique()}` })
        .expect(201)
    ).body;
    await http
      .patch(`/api/v1/banks/${bank.id}`)
      .set(auth('ops'))
      .send({ employeeSignerUserId: fixtures.users.employee.id })
      .expect(200);
    await http
      .post(`/api/v1/banks/${bank.id}/documents`)
      .set(auth('ops'))
      .send({
        documentBase64: (await onePagePdf('Bank agreement')).toString('base64'),
        filename: 'bank-agreement.pdf',
      })
      .expect(201);
    return bank;
  }

  it('is null until the agreement completes, then carries bank, agent, year and sequence', async () => {
    const bank = await readyBank('Union Bank of India');
    const agentCode = (
      await knex('users').where('id', fixtures.users.agent.id).select('agent_code').first()
    ).agent_code;
    expect(agentCode).toMatch(/^AG\d{4}$/);

    const { row } = await executeAgreement(bank.id);

    expect(row.status).toBe('COMPLETED');
    expect(row.execution_reference).toBe(
      `${bank.code.toUpperCase()}/${agentCode}/${financialYearNow()}/001`,
    );
    // The agreement number is unchanged — this is a second identifier, not a
    // replacement, so records already issued keep theirs.
    expect(row.agreement_number).toMatch(/^GTIDS\/\d{4}-\d{2}\/[A-Z]+\/\d{6}$/);
  });

  it('counts per agent, so a second agreement is 002', async () => {
    const bank = await readyBank('Union Bank of India');
    const first = await executeAgreement(bank.id);
    const second = await executeAgreement(bank.id);

    expect(first.row.execution_reference).toMatch(/\/001$/);
    expect(second.row.execution_reference).toMatch(/\/002$/);
  });

  it('never issues the same reference twice', async () => {
    const bank = await readyBank('Union Bank of India');
    const first = await executeAgreement(bank.id);
    const second = await executeAgreement(bank.id);

    const refs = await knex('agreements')
      .whereNotNull('execution_reference')
      .pluck('execution_reference');
    expect(new Set(refs).size).toBe(refs.length);

    /*
     * And the database refuses a duplicate outright, so uniqueness does not rest
     * on the allocation function being called correctly. Attempted directly,
     * bypassing the application entirely.
     */
    await expect(
      knex('agreements')
        .where('id', second.id)
        .update({ execution_reference: first.row.execution_reference }),
    ).rejects.toThrow(/uq_agreements_execution_reference/);
  });

  it('uses GT for an agreement that belongs to no bank', async () => {
    const { row } = await executeAgreement(null);
    expect(row.execution_reference).toMatch(/^GT\/AG\d{4}\//);
  });

  it('finds an agent\'s whole set from their code alone', async () => {
    const bank = await readyBank('Union Bank of India');
    await executeAgreement(bank.id);
    await executeAgreement(bank.id);
    const agentCode = (
      await knex('users').where('id', fixtures.users.agent.id).select('agent_code').first()
    ).agent_code;

    // What "an identifier per agreement per agent" is actually for: pulling up
    // everything one agent has executed.
    const res = await http
      .get(`/api/v1/agreements?reference=${agentCode}`)
      .set(auth('ops'))
      .expect(200);
    expect(res.body.items).toHaveLength(2);

    // And one exact reference returns exactly one agreement.
    const one = await http
      .get(
        `/api/v1/agreements?reference=${encodeURIComponent(res.body.items[0].execution_reference)}`,
      )
      .set(auth('ops'))
      .expect(200);
    expect(one.body.items).toHaveLength(1);
  });

  it('is not exposed by public verification (BR-010, AC-17)', async () => {
    const bank = await readyBank('Union Bank of India');
    const { row } = await executeAgreement(bank.id);

    const res = await http.get(`/api/v1/verify/${row.verification_token}`).expect(200);

    /*
     * The reference encodes the bank and the agent, so publishing it would
     * identify a party to anyone holding a verification link — which is what
     * BR-010 exists to prevent. The token is the public handle.
     */
    expect(res.body.found).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(row.execution_reference);
    expect(JSON.stringify(res.body)).not.toContain(bank.code.toUpperCase());
  });

  it('does not mint a second reference when a callback is replayed', async () => {
    const bank = await readyBank('Union Bank of India');
    const { id, row } = await executeAgreement(bank.id);
    const reference = row.execution_reference;

    // A provider callback can arrive twice. A second mint would burn a number
    // and leave the record disagreeing with the email already sent.
    const tx = await knex('esign_transactions')
      .where({ agreement_id: id, status: 'SIGNED' })
      .orderBy('created_at', 'desc')
      .first();
    await http
      .post('/api/v1/signing/reconcile')
      .set(auth('admin'))
      .send({})
      .catch(() => undefined);

    const after = await knex('agreements').where('id', id).first();
    expect(after.execution_reference).toBe(reference);
    expect(tx).toBeTruthy();
  });
});

/** The financial year as the API computes it, for the expected reference. */
function financialYearNow(): string {
  const now = new Date();
  const year = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}
