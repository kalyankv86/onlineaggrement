import type { Knex } from 'knex';
import * as dotenv from 'dotenv';

// No __dirname: Node 24 loads this file as an ES module (it has import/export
// syntax), so the CommonJS globals are not in scope. Run knex from ./api.
dotenv.config({ path: '.env' });

/**
 * Two connection identities exist deliberately (DEC-011 / SDD v1.1 §B10):
 *
 *   DATABASE_URL       — the *application* role. It is granted INSERT and SELECT on
 *                        audit_logs and nothing more. It cannot UPDATE or DELETE audit
 *                        records even if application code tries.
 *   MIGRATION_DATABASE_URL — the owner role, used only by migrations. Falls back to
 *                        DATABASE_URL for local development.
 */
const connection = (url?: string): Knex.PgConnectionConfig | string =>
  url ?? 'postgresql://localhost:5432/gtids_agreements';

const base: Knex.Config = {
  client: 'pg',
  pool: { min: 2, max: 10 },
  migrations: { directory: './migrations', extension: 'ts', tableName: 'knex_migrations' },
  seeds: { directory: './seeds', extension: 'ts' },
};

const config: Record<string, Knex.Config> = {
  development: {
    ...base,
    connection: connection(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL),
  },
  test: {
    ...base,
    connection: connection(
      process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/gtids_agreements_test',
    ),
    pool: { min: 1, max: 5 },
  },
  production: {
    ...base,
    connection: connection(process.env.MIGRATION_DATABASE_URL),
    pool: { min: 2, max: 20 },
  },
};

export default config;
