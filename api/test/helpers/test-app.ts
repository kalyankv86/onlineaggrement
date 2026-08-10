import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import knexLib, { Knex } from 'knex';
import bcrypt from 'bcryptjs';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/errors/domain-exception.filter';

const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/gtids_agreements_test';
const TEST_STORAGE = path.resolve(__dirname, '../../.test-storage');

/**
 * Boots the real application against the test database — no mocked services.
 *
 * Integration and E2E tests exercise the actual Postgres constraints, triggers and
 * transactions, because that is where most of this system's guarantees live. A
 * suite built on in-memory doubles would pass while the partial unique index and
 * the audit triggers did nothing.
 */
export async function createTestApp(): Promise<{
  app: INestApplication;
  knex: Knex;
  close: () => Promise<void>;
}> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DB;
  process.env.STORAGE_DRIVER = 'filesystem';
  process.env.STORAGE_FS_ROOT = TEST_STORAGE;
  process.env.ESIGN_PROVIDER = 'mock';
  process.env.PDF_RENDERER = 'pdflib';
  process.env.SMTP_TRANSPORT = 'json';
  process.env.JWT_SECRET = 'test-secret-not-used-anywhere-else';
  process.env.ESIGN_CALLBACK_SECRET = 'test-callback-secret';
  process.env.RUN_SCHEDULER = 'false'; // tests drive the jobs explicitly

  await migrateTestDatabase();
  await fs.rm(TEST_STORAGE, { recursive: true, force: true });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });

  // Same raw-body capture as production: the callback signature covers the exact
  // bytes the provider sent (DEC-010).
  app.use(
    express.json({
      limit: '15mb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.init();

  const knex = knexLib({ client: 'pg', connection: TEST_DB, pool: { min: 1, max: 5 } });

  return {
    app,
    knex,
    close: async () => {
      await knex.destroy();
      await app.close();
      await fs.rm(TEST_STORAGE, { recursive: true, force: true });
    },
  };
}

async function migrateTestDatabase(): Promise<void> {
  const db = knexLib({
    client: 'pg',
    connection: TEST_DB,
    migrations: { directory: path.resolve(__dirname, '../../migrations'), extension: 'ts' },
  });
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}

/**
 * Clear transactional data between tests.
 *
 * `audit_logs` and `agreement_documents` carry triggers that reject DELETE, so
 * they are truncated with the triggers momentarily disabled — the only place in
 * the codebase that does this, and only against the test database.
 *
 * Object storage is wiped alongside the database. TRUNCATE ... RESTART IDENTITY
 * resets the agreement-number sequence, so the next test reuses the same object
 * keys; leaving the files in place would make the write-once rule reject them —
 * correctly. In production agreement numbers never repeat.
 */
export async function resetData(knex: Knex): Promise<void> {
  // Clear the contents but keep the root itself: in production it is a NAS
  // mountpoint that always exists, and the storage driver refuses to write when
  // the root is missing (it reads that as an unmounted share).
  await fs.rm(TEST_STORAGE, { recursive: true, force: true });
  await fs.mkdir(TEST_STORAGE, { recursive: true });
  await knex.raw(`
    ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable;
    ALTER TABLE audit_chain_heads DISABLE TRIGGER trg_audit_chain_heads_no_delete;
    ALTER TABLE agreement_documents DISABLE TRIGGER trg_agreement_documents_immutable;
    ALTER TABLE agreements DISABLE TRIGGER trg_agreements_completed_immutable;

    TRUNCATE
      audit_logs, audit_chain_heads, outbox_events,
      notification_recipients, notifications,
      signature_events, esign_callback_events, esign_transactions,
      identity_verifications, digilocker_transactions,
      agreement_documents, agreement_versions,
      stamp_allocations, stamp_papers,
      workflow_transitions, agreement_version_history,
      party_access_tokens, agreement_parties, agreements,
      agreement_number_sequences
    RESTART IDENTITY CASCADE;

    ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable;
    ALTER TABLE audit_chain_heads ENABLE TRIGGER trg_audit_chain_heads_no_delete;
    ALTER TABLE agreement_documents ENABLE TRIGGER trg_agreement_documents_immutable;
    ALTER TABLE agreements ENABLE TRIGGER trg_agreements_completed_immutable;
  `);
}

export interface SeededFixtures {
  users: Record<string, { id: string; email: string }>;
  agreementTypeId: string;
  templateVersionId: string;
  password: string;
}

/** Roles, users, an agreement type and an approved template — the minimum to transact. */
export async function seedFixtures(knex: Knex): Promise<SeededFixtures> {
  const password = 'TestPassword-2026!';
  const passwordHash = await bcrypt.hash(password, 4); // low cost: tests log in often

  const roleCodes = ['SUPER_ADMIN', 'AGREEMENT_ADMIN', 'AGENT', 'EMPLOYEE', 'MD', 'AUDITOR'];
  const roleIds: Record<string, string> = {};
  for (const code of roleCodes) {
    const existing = await knex('roles').where('code', code).first();
    if (existing) {
      roleIds[code] = existing.id;
    } else {
      const [row] = await knex('roles')
        .insert({ code, name: code, is_system: true })
        .returning('id');
      roleIds[code] = row.id;
    }
  }

  const people: [string, string, string][] = [
    ['admin', 'admin@test.gtids', 'SUPER_ADMIN'],
    ['ops', 'ops@test.gtids', 'AGREEMENT_ADMIN'],
    ['agent', 'agent@test.gtids', 'AGENT'],
    ['employee', 'employee@test.gtids', 'EMPLOYEE'],
    ['md', 'md@test.gtids', 'MD'],
    ['auditor', 'auditor@test.gtids', 'AUDITOR'],
  ];

  const users: SeededFixtures['users'] = {};
  for (const [key, email, roleCode] of people) {
    let user = await knex('users').where('email', email).first();
    if (!user) {
      [user] = await knex('users')
        .insert({
          email,
          full_name: key.toUpperCase(),
          password_hash: passwordHash,
          user_type: 'INTERNAL',
        })
        .returning('*');
    } else {
      await knex('users').where('id', user.id).update({ password_hash: passwordHash });
    }
    users[key] = { id: user.id, email };
    await knex('user_roles')
      .insert({ user_id: user.id, role_id: roleIds[roleCode] })
      .onConflict(['user_id', 'role_id'])
      .ignore();
  }

  let type = await knex('agreement_types').where('code', 'TSTAGR').first();
  if (!type) {
    [type] = await knex('agreement_types')
      .insert({
        code: 'TSTAGR',
        name: 'Test Agreement',
        requires_stamp: true,
        stamp_denomination: 100,
      })
      .returning('*');

    await knex('stage_slas').insert(
      ['READY_FOR_AGENT_SIGNATURE', 'PENDING_EMPLOYEE_APPROVAL', 'PENDING_MD_SIGNATURE'].map(
        (stage) => ({
          agreement_type_id: type.id,
          stage,
          sla_days: 14,
          reminder_days: knex.raw(`'{3,7,12}'::integer[]`),
        }),
      ),
    );
  }

  let templateVersion = await knex('agreement_template_versions')
    .join('agreement_templates', 'agreement_templates.id', 'agreement_template_versions.template_id')
    .where('agreement_templates.agreement_type_id', type.id)
    .select('agreement_template_versions.*')
    .first();

  if (!templateVersion) {
    const [template] = await knex('agreement_templates')
      .insert({ agreement_type_id: type.id, name: 'Test template' })
      .returning('*');
    [templateVersion] = await knex('agreement_template_versions')
      .insert({
        template_id: template.id,
        version_no: 1,
        content: '<h1>Test Agreement</h1><p>Between GTIDS and {{agentName}} for {{consideration}}.</p>',
        variables_schema: JSON.stringify({ required: ['agentName', 'consideration'] }),
        status: 'APPROVED',
        created_by: users.ops.id,
        approved_by: users.admin.id,
        approved_at: new Date(),
      })
      .returning('*');
  }

  return {
    users,
    agreementTypeId: type.id,
    templateVersionId: templateVersion.id,
    password,
  };
}

/** Poll until `check` passes — the callback path is deliberately asynchronous. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 100, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result as T;
      last = result;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

/** Minimal base64 PDF, used as a stand-in stamp-paper scan. */
export const SAMPLE_STAMP_SCAN_BASE64 = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
).toString('base64');
