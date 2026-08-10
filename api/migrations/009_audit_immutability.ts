import type { Knex } from 'knex';

/**
 * Audit immutability — DEC-011 / FR-025 / BR-009 / AC-15 / AC-16.
 *
 * Three independent layers, so defeating one does not defeat the property:
 *
 *   1. PRIVILEGE — the application role holds INSERT and SELECT only. Even a code
 *      path that tries to UPDATE an audit row is refused by the server.
 *   2. TRIGGER   — UPDATE and DELETE raise unconditionally. This still holds when
 *      the connection is a superuser (as it is in local development), which is
 *      why layer 1 alone was not considered sufficient.
 *   3. HASH CHAIN — computed *in the database* on INSERT, so application code
 *      cannot choose the linkage. Excising a row breaks the chain detectably even
 *      for an actor holding database privileges.
 */
export async function up(knex: Knex): Promise<void> {
  const NIL_UUID = '00000000-0000-0000-0000-000000000000';

  // ── Layer 3: chain the row to its predecessor, at insert time. ──────────────
  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION audit_logs_chain() RETURNS trigger AS $$
    DECLARE
      v_key  uuid := COALESCE(NEW.agreement_id, '${NIL_UUID}'::uuid);
      v_prev text;
    BEGIN
      -- Serialise appends per chain. Concurrent inserts for the same agreement
      -- queue here, which is what keeps the chain linear.
      SELECT head_hash INTO v_prev FROM audit_chain_heads
        WHERE agreement_id = v_key FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO audit_chain_heads (agreement_id, head_hash, record_count)
          VALUES (v_key, repeat('0', 64), 0)
          ON CONFLICT (agreement_id) DO NOTHING;
        SELECT head_hash INTO v_prev FROM audit_chain_heads
          WHERE agreement_id = v_key FOR UPDATE;
      END IF;

      NEW.prev_hash := v_prev;
      NEW.row_hash := encode(
        sha256(convert_to(
          v_prev
          || COALESCE(NEW.agreement_id::text, '')
          || COALESCE(NEW.agreement_version::text, '')
          || COALESCE(NEW.actor_id::text, '')
          || NEW.event_type
          || COALESCE(NEW.event_data::text, '{}')
          || to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
          'UTF8')),
        'hex');

      UPDATE audit_chain_heads
        SET head_hash = NEW.row_hash,
            record_count = record_count + 1,
            updated_at = now()
        WHERE agreement_id = v_key;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_audit_logs_chain
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();
  `);

  // ── Layer 2: refuse mutation outright. ─────────────────────────────────────
  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'BR-009: audit records are append-only (attempted % on audit_logs)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_audit_logs_immutable
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

    -- The chain heads are derived state; only the chain trigger may move them.
    CREATE OR REPLACE FUNCTION reject_chain_head_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_chain_heads rows cannot be deleted'
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_audit_chain_heads_no_delete
      BEFORE DELETE ON audit_chain_heads
      FOR EACH ROW EXECUTE FUNCTION reject_chain_head_delete();
  `);

  // ── Layer 1: privilege. Idempotent, and harmless if the role is unused locally.
  await knex.schema.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtids_app') THEN
        CREATE ROLE gtids_app NOLOGIN;
      END IF;
    END $$;

    GRANT USAGE ON SCHEMA public TO gtids_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gtids_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gtids_app;

    -- ...except the audit tables, which are append-only for the application.
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM gtids_app;
    REVOKE DELETE, TRUNCATE ON audit_chain_heads FROM gtids_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON agreement_documents FROM gtids_app;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gtids_app;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS trg_audit_chain_heads_no_delete ON audit_chain_heads;
    DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
    DROP TRIGGER IF EXISTS trg_audit_logs_chain ON audit_logs;
    DROP FUNCTION IF EXISTS reject_chain_head_delete();
    DROP FUNCTION IF EXISTS reject_audit_mutation();
    DROP FUNCTION IF EXISTS audit_logs_chain();
  `);
}
