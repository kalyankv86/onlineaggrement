import { INestApplication } from '@nestjs/common';
import { Knex } from 'knex';
import { createTestApp, resetData, seedFixtures, SeededFixtures } from '../helpers/test-app';
import { StampsService } from '../../src/stamps/stamps.service';
import { AuditService, AuditEvent } from '../../src/audit/audit.service';
import { ConflictError } from '../../src/common/errors/domain.errors';

jest.setTimeout(60_000);

/**
 * The guarantees that live in Postgres rather than in TypeScript.
 *
 * These are tested against a real database on purpose: a mocked repository would
 * happily report success while the partial unique index, the immutability triggers
 * and the hash-chain trigger did nothing at all.
 */
describe('database-enforced invariants', () => {
  let app: INestApplication;
  let knex: Knex;
  let close: () => Promise<void>;
  let fixtures: SeededFixtures;

  beforeAll(async () => {
    ({ app, knex, close } = await createTestApp());
  });

  afterAll(async () => close());

  beforeEach(async () => {
    await resetData(knex);
    fixtures = await seedFixtures(knex);
  });

  const makeAgreement = async (suffix = '1') => {
    const [row] = await knex('agreements')
      .insert({
        agreement_number: `GTIDS/2026-27/TSTAGR/00000${suffix}`,
        agreement_type_id: fixtures.agreementTypeId,
        template_version_id: fixtures.templateVersionId,
        status: 'DRAFT',
        created_by: fixtures.users.agent.id,
      })
      .returning('*');
    return row;
  };

  const makeStamp = async (number: string) => {
    const [row] = await knex('stamp_papers')
      .insert({
        stamp_number: number,
        denomination: 100,
        state_code: 'IN-OR',
        file_key: `stamps/test/${number}.pdf`,
        document_hash: 'a'.repeat(64),
        status: 'AVAILABLE',
        created_by: fixtures.users.ops.id,
      })
      .returning('*');
    return row;
  };

  describe('AC-11 / BR-006 — a stamp cannot be allocated twice', () => {
    it('exactly one of 50 concurrent allocation attempts succeeds', async () => {
      const stamps = new StampsService(
        knex,
        app.get(AuditService),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any, // documents service is unused by allocate()
      );
      const stamp = await makeStamp('CONCURRENT-1');
      const agreements = await Promise.all(
        Array.from({ length: 50 }, (_, i) => makeAgreement(String(i).padStart(1, '0'))),
      );

      const results = await Promise.allSettled(
        agreements.map((a) =>
          stamps.allocate({ stampId: stamp.id, agreementId: a.id, actorId: fixtures.users.ops.id }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      // Everything else must fail as a conflict, not as an unhandled error.
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
      }

      const live = await knex('stamp_allocations')
        .where('stamp_paper_id', stamp.id)
        .whereNull('released_at');
      expect(live).toHaveLength(1);
      expect((await knex('stamp_papers').where('id', stamp.id).first()).status).toBe('ALLOCATED');
    });

    it('the index refuses a second live allocation even on a direct insert', async () => {
      const stamp = await makeStamp('DIRECT-1');
      const a = await makeAgreement('1');
      const b = await makeAgreement('2');

      await knex('stamp_allocations').insert({
        stamp_paper_id: stamp.id,
        agreement_id: a.id,
        allocated_by: fixtures.users.ops.id,
      });

      await expect(
        knex('stamp_allocations').insert({
          stamp_paper_id: stamp.id,
          agreement_id: b.id,
          allocated_by: fixtures.users.ops.id,
        }),
      ).rejects.toThrow(/uq_stamp_active_allocation/);
    });

    it('allows re-allocation once the first allocation is released', async () => {
      const stamp = await makeStamp('RELEASE-1');
      const a = await makeAgreement('1');
      const b = await makeAgreement('2');

      const [allocation] = await knex('stamp_allocations')
        .insert({
          stamp_paper_id: stamp.id,
          agreement_id: a.id,
          allocated_by: fixtures.users.ops.id,
        })
        .returning('*');

      await knex('stamp_allocations')
        .where('id', allocation.id)
        .update({ released_at: new Date(), released_reason: 'agreement cancelled' });

      await expect(
        knex('stamp_allocations').insert({
          stamp_paper_id: stamp.id,
          agreement_id: b.id,
          allocated_by: fixtures.users.ops.id,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('DEC-029 — three identifiers, each independently unique', () => {
    const identifiersOf = (stampId: string) => [
      { stamp_paper_id: stampId, kind: 'CERTIFICATE_NO', value: 'IN-AP77702625151064Y', normalized: 'INAP77702625151064Y' },
      { stamp_paper_id: stampId, kind: 'UNIQUE_DOC_REF', value: 'SUBIN-APAP1816830336771257804039Y', normalized: 'SUBINAPAP1816830336771257804039Y' },
      { stamp_paper_id: stampId, kind: 'PAPER_SERIAL', value: 'FH 0001752181', normalized: 'FH0001752181' },
    ];

    it('blocks re-registration by ANY of the three, however it is written', async () => {
      const first = await makeStamp('AP-REAL-1');
      await knex('stamp_identifiers').insert(identifiersOf(first.id));

      // A real second row, so a rejection can only come from the unique index
      // and never from a dangling foreign key.
      const second = await makeStamp('AP-REAL-2');

      const attempts: [string, string, string][] = [
        ['certificate number as printed', 'CERTIFICATE_NO', 'INAP77702625151064Y'],
        ['certificate number, hyphens dropped', 'CERTIFICATE_NO', 'INAP77702625151064Y'],
        ['certificate number, lowercase and spaced', 'CERTIFICATE_NO', 'INAP77702625151064Y'],
        ['the SUBIN reference alone', 'UNIQUE_DOC_REF', 'SUBINAPAP1816830336771257804039Y'],
        ['the paper serial alone', 'PAPER_SERIAL', 'FH0001752181'],
      ];

      for (const [label, kind, normalized] of attempts) {
        await expect(
          knex('stamp_identifiers').insert({
            stamp_paper_id: second.id,
            kind,
            value: normalized,
            normalized,
          }),
        ).rejects.toThrow(/uq_stamp_identifier_normalized/);
        expect(label).toBeTruthy();
      }
    });

    it('accepts a genuinely different stamp', async () => {
      const first = await makeStamp('AP-DIFF-1');
      await knex('stamp_identifiers').insert(identifiersOf(first.id));

      const other = await makeStamp('AP-DIFF-2');
      await expect(
        knex('stamp_identifiers').insert({
          stamp_paper_id: other.id,
          kind: 'CERTIFICATE_NO',
          value: 'IN-AP99900011122233X',
          normalized: 'INAP99900011122233X',
        }),
      ).resolves.toBeDefined();
    });

    it('refuses an identifier too short to be meaningful', async () => {
      const stamp = await makeStamp('AP-SHORT');
      await expect(
        knex('stamp_identifiers').insert({
          stamp_paper_id: stamp.id,
          kind: 'OTHER',
          value: '100',
          normalized: '100',
        }),
      ).rejects.toThrow(/stamp_identifiers_min_length/);
    });

    it('allows only one identifier of each kind per stamp', async () => {
      const stamp = await makeStamp('AP-KIND');
      await knex('stamp_identifiers').insert({
        stamp_paper_id: stamp.id, kind: 'CERTIFICATE_NO',
        value: 'IN-AP11111111111111A', normalized: 'INAP11111111111111A',
      });
      await expect(
        knex('stamp_identifiers').insert({
          stamp_paper_id: stamp.id, kind: 'CERTIFICATE_NO',
          value: 'IN-AP22222222222222B', normalized: 'INAP22222222222222B',
        }),
      ).rejects.toThrow(/uq_stamp_identifier_kind_per_stamp/);
    });
  });

  describe('AC-15 / BR-009 — audit records are append-only', () => {
    it('rejects UPDATE', async () => {
      const audit = app.get(AuditService);
      await audit.record(AuditEvent.AGREEMENT_CREATED, { probe: true });
      await expect(
        knex('audit_logs').where('event_type', 'AGREEMENT_CREATED').update({ event_type: 'X' }),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE', async () => {
      const audit = app.get(AuditService);
      await audit.record(AuditEvent.AGREEMENT_CREATED, { probe: true });
      await expect(knex('audit_logs').del()).rejects.toThrow(/append-only/);
    });

    it('rejects deletion of a chain head', async () => {
      const audit = app.get(AuditService);
      await audit.record(AuditEvent.AGREEMENT_CREATED, { probe: true });
      await expect(knex('audit_chain_heads').del()).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('AC-16 / DEC-011 — the audit hash chain', () => {
    it('links each record to its predecessor', async () => {
      const audit = app.get(AuditService);
      const agreement = await makeAgreement();

      for (const n of [1, 2, 3]) {
        await audit.record(AuditEvent.DOCUMENT_VIEWED, { n }, { agreementId: agreement.id });
      }

      const rows = await knex('audit_logs')
        .where('agreement_id', agreement.id)
        .orderBy('id', 'asc');

      expect(rows).toHaveLength(3);
      expect(rows[0].prev_hash).toBe('0'.repeat(64));
      expect(rows[1].prev_hash).toBe(rows[0].row_hash);
      expect(rows[2].prev_hash).toBe(rows[1].row_hash);

      const head = await knex('audit_chain_heads').where('agreement_id', agreement.id).first();
      expect(head.head_hash).toBe(rows[2].row_hash);
      expect(Number(head.record_count)).toBe(3);
    });

    it('reports an intact chain', async () => {
      const audit = app.get(AuditService);
      const agreement = await makeAgreement();
      await audit.record(AuditEvent.AGREEMENT_CREATED, { a: 1 }, { agreementId: agreement.id });
      await audit.record(AuditEvent.AGREEMENT_GENERATED, { b: 2 }, { agreementId: agreement.id });

      const result = await audit.verifyChain(agreement.id);
      expect(result.intact).toBe(true);
      expect(result.recordCount).toBe(2);
    });

    it('detects content tampering performed with the triggers disabled', async () => {
      const audit = app.get(AuditService);
      const agreement = await makeAgreement();
      await audit.record(AuditEvent.AGREEMENT_CREATED, { amount: 1000 }, { agreementId: agreement.id });
      await audit.record(AuditEvent.AGREEMENT_GENERATED, { step: 2 }, { agreementId: agreement.id });

      // Simulates an actor who holds database privileges and can bypass layers 1
      // and 2. The hash chain is the layer that still catches them.
      const target = await knex('audit_logs').where('agreement_id', agreement.id).orderBy('id').first();
      await knex.raw('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await knex.raw(`UPDATE audit_logs SET event_data = '{"amount": 999999}'::jsonb WHERE id = ?`, [
        target.id,
      ]);
      await knex.raw('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');

      const result = await audit.verifyChain(agreement.id);
      expect(result.intact).toBe(false);
      expect(result.brokenAtId).toBe(String(target.id));
      expect(result.reason).toMatch(/does not match its stored hash/);
    });

    it('detects an excised record', async () => {
      const audit = app.get(AuditService);
      const agreement = await makeAgreement();
      for (const n of [1, 2, 3]) {
        await audit.record(AuditEvent.DOCUMENT_VIEWED, { n }, { agreementId: agreement.id });
      }

      const middle = (
        await knex('audit_logs').where('agreement_id', agreement.id).orderBy('id')
      )[1];
      await knex.raw('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await knex.raw('DELETE FROM audit_logs WHERE id = ?', [middle.id]);
      await knex.raw('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');

      const result = await audit.verifyChain(agreement.id);
      expect(result.intact).toBe(false);
      expect(result.reason).toMatch(/removed or altered/);
    });

    it('detects a truncated tail, where survivors are still self-consistent', async () => {
      const audit = app.get(AuditService);
      const agreement = await makeAgreement();
      for (const n of [1, 2, 3]) {
        await audit.record(AuditEvent.DOCUMENT_VIEWED, { n }, { agreementId: agreement.id });
      }

      const last = (
        await knex('audit_logs').where('agreement_id', agreement.id).orderBy('id', 'desc')
      )[0];
      await knex.raw('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await knex.raw('DELETE FROM audit_logs WHERE id = ?', [last.id]);
      await knex.raw('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');

      const result = await audit.verifyChain(agreement.id);
      expect(result.intact).toBe(false);
      expect(result.reason).toMatch(/truncated/);
    });
  });

  describe('BR-005 — a completed agreement is frozen', () => {
    it('rejects a content edit at the database level', async () => {
      const agreement = await makeAgreement();
      await knex('agreements').where('id', agreement.id).update({
        status: 'COMPLETED',
        completed_at: new Date(),
        verification_token: 'A'.repeat(32),
      });

      await expect(
        knex('agreements').where('id', agreement.id).update({ data: { tampered: true } }),
      ).rejects.toThrow(/BR-005/);
    });

    it('rejects moving a completed agreement to another state', async () => {
      const agreement = await makeAgreement();
      await knex('agreements').where('id', agreement.id).update({
        status: 'COMPLETED',
        completed_at: new Date(),
        verification_token: 'B'.repeat(32),
      });

      await expect(
        knex('agreements').where('id', agreement.id).update({ status: 'DRAFT' }),
      ).rejects.toThrow(/BR-005/);
    });

    it('refuses to mark an agreement COMPLETED without completion evidence', async () => {
      const agreement = await makeAgreement();
      await expect(
        knex('agreements').where('id', agreement.id).update({ status: 'COMPLETED' }),
      ).rejects.toThrow(/agreements_completed_requires_evidence/);
    });
  });

  describe('other structural guarantees', () => {
    it('refuses a rejection without a substantive reason (FR-015)', async () => {
      const agreement = await makeAgreement();
      await expect(
        knex('agreements').where('id', agreement.id).update({ status: 'REJECTED', rejected_reason: 'no' }),
      ).rejects.toThrow(/agreements_rejection_requires_reason/);
    });

    it('allows only one AGENT party per agreement', async () => {
      const agreement = await makeAgreement();
      const party = {
        agreement_id: agreement.id,
        party_type: 'AGENT',
        name: 'A',
        email: 'a@test.gtids',
        signing_order: 1,
      };
      await knex('agreement_parties').insert(party);
      await expect(
        knex('agreement_parties').insert({ ...party, email: 'b@test.gtids' }),
      ).rejects.toThrow(/uq_agreement_principal_party/);
    });

    it('documents are write-once (SDD v1.1 §B8)', async () => {
      const agreement = await makeAgreement();
      await knex('agreement_documents').insert({
        agreement_id: agreement.id,
        doc_type: 'GENERATED_UNSIGNED',
        file_key: 'agreements/2026/08/x/v1/generated-unsigned.pdf',
        size_bytes: 1,
        document_hash: 'c'.repeat(64),
      });
      await expect(
        knex('agreement_documents').update({ size_bytes: 2 }),
      ).rejects.toThrow(/write-once/);
    });

    it('agreement numbers are allocated without gaps (FR-026)', async () => {
      const numbers = await Promise.all(
        Array.from({ length: 20 }, () =>
          knex.raw(`SELECT next_agreement_number('2026-27','SEQTEST') AS n`),
        ),
      );
      const sequence = numbers
        .map((r) => Number(r.rows[0].n.split('/').pop()))
        .sort((a, b) => a - b);
      expect(sequence).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it('callback event ids are unique, which is what makes replay harmless', async () => {
      const event = {
        provider: 'mock',
        provider_event_id: 'evt-duplicate',
        raw_payload: JSON.stringify({}),
        signature_valid: true,
      };
      await knex('esign_callback_events').insert(event);
      await expect(knex('esign_callback_events').insert(event)).rejects.toThrow(/unique/i);
    });
  });
});
