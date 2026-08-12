/**
 * Knex configuration — CommonJS on purpose.
 *
 * A TypeScript knexfile requires knex to find a TS loader (ts-node, sucrase, …)
 * at run time. In production the release tree is pruned to production
 * dependencies, so no loader exists and `knex migrate:latest` fails with
 * "Required configuration option 'client' is missing" — the config file having
 * silently failed to load. Production must not depend on a TypeScript toolchain.
 *
 * Paths are resolved from __dirname rather than the working directory, so the
 * command works from anywhere.
 *
 * Two connection identities exist deliberately (DEC-011 / SDD v1.1 §B10):
 *
 *   DATABASE_URL           — the *application* role. Granted INSERT and SELECT on
 *                            audit_logs and nothing more; it cannot UPDATE or
 *                            DELETE audit records even if application code tries.
 *   MIGRATION_DATABASE_URL — the owner role, used only by migrations. Falls back
 *                            to DATABASE_URL for local development.
 */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

/*
 * Deployed environments run the compiled migrations built by `npm run build:db`;
 * development always runs the TypeScript sources.
 *
 * The environment is part of the condition, not just the presence of the compiled
 * directory. Keying off existence alone means a developer who edits a migration
 * and runs `npm run migrate` without rebuilding silently applies a stale copy —
 * and finds out later, against a schema that does not match the source.
 */
const deployed = ['production', 'staging'].includes(process.env.NODE_ENV || '');
const compiledDir = path.join(__dirname, 'dist-db', 'migrations');
const useCompiled = deployed && fs.existsSync(compiledDir);

const migrations = {
  directory: useCompiled ? compiledDir : path.join(__dirname, 'migrations'),
  extension: useCompiled ? 'js' : 'ts',
  loadExtensions: useCompiled ? ['.js'] : ['.ts'],
  tableName: 'knex_migrations',
};

const seeds = {
  directory: useCompiled
    ? path.join(__dirname, 'dist-db', 'seeds')
    : path.join(__dirname, 'seeds'),
  extension: useCompiled ? 'js' : 'ts',
  loadExtensions: useCompiled ? ['.js'] : ['.ts'],
};

const base = { client: 'pg', pool: { min: 2, max: 10 }, migrations, seeds };

const url = (fallback) =>
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || fallback;

module.exports = {
  development: {
    ...base,
    connection: url('postgresql://localhost:5432/gtids_agreements'),
  },
  staging: {
    ...base,
    connection: url('postgresql://localhost:5432/gtids_agreements'),
  },
  test: {
    ...base,
    connection:
      process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/gtids_agreements_test',
    pool: { min: 1, max: 5 },
  },
  production: {
    ...base,
    connection: process.env.MIGRATION_DATABASE_URL,
    pool: { min: 2, max: 20 },
  },
};
