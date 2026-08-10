import type { Knex } from 'knex';

/** The aggregate root, its parties, version history and transition log. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agreements', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('agreement_number', 60).notNullable().unique(); // FR-026
    t.uuid('agreement_type_id').notNullable().references('id').inTable('agreement_types');
    t.uuid('template_version_id').notNullable().references('id').inTable('agreement_template_versions');
    t.specificType('status', 'agreement_status').notNullable().defaultTo('DRAFT');
    t.integer('current_version').notNullable().defaultTo(1);
    t.string('stamp_type', 30).notNullable().defaultTo('PHYSICAL');
    t.string('place_of_execution_state', 10);
    // DEC-006 — random, not derived from the agreement number. Minted at COMPLETED.
    t.string('verification_token', 32).unique();
    t.specificType('party_access_mode', 'party_access_mode').notNullable().defaultTo('INTERNAL');
    t.timestamp('expires_at', { useTz: true });
    t.jsonb('data').notNullable().defaultTo('{}'); // template variable values
    t.text('rejected_reason');
    t.uuid('rejected_by').references('id').inTable('users');
    t.timestamp('rejected_at', { useTz: true });
    // Optimistic concurrency for API-level lost updates; row locks handle the rest.
    t.integer('row_version').notNullable().defaultTo(1);
    t.uuid('created_by').notNullable().references('id').inTable('users');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at', { useTz: true });

    t.check('current_version >= 1', undefined, 'agreements_version_positive');
    t.check(
      `(status <> 'COMPLETED') OR (completed_at IS NOT NULL AND verification_token IS NOT NULL)`,
      undefined,
      'agreements_completed_requires_evidence',
    );
    t.check(
      `(status <> 'REJECTED') OR (rejected_reason IS NOT NULL AND length(rejected_reason) >= 10)`,
      undefined,
      'agreements_rejection_requires_reason',
    );
  });

  await knex.schema.raw(`
    CREATE INDEX idx_agreements_status ON agreements (status);
    CREATE INDEX idx_agreements_type   ON agreements (agreement_type_id);
    CREATE INDEX idx_agreements_creator ON agreements (created_by);
    -- Only non-terminal agreements can expire; keep the SLA sweep index small.
    CREATE INDEX idx_agreements_expiry ON agreements (expires_at)
      WHERE status NOT IN ('COMPLETED','CANCELLED','REJECTED','EXPIRED');
  `);

  await knex.schema.createTable('agreement_parties', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.specificType('party_type', 'party_type').notNullable();
    t.uuid('user_id').references('id').inTable('users'); // null for external parties
    t.string('name', 200).notNullable();
    t.specificType('email', 'citext').notNullable();
    t.string('mobile', 20);
    t.string('identity_reference', 100); // masked only — never a full Aadhaar number
    t.integer('signing_order').notNullable();
    t.specificType('status', 'party_status').notNullable().defaultTo('PENDING');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Exactly one Agent, one Employee and one MD per agreement (§4 Actors).
  await knex.schema.raw(`
    CREATE UNIQUE INDEX uq_agreement_principal_party
      ON agreement_parties (agreement_id, party_type)
      WHERE party_type IN ('AGENT','EMPLOYEE','MD');
    CREATE INDEX idx_agreement_parties_agreement ON agreement_parties (agreement_id);
  `);

  // Deferred FKs from 002 now that agreements/parties exist.
  await knex.schema.raw(`
    ALTER TABLE party_access_tokens
      ADD CONSTRAINT party_access_tokens_agreement_fk
        FOREIGN KEY (agreement_id) REFERENCES agreements (id) ON DELETE CASCADE,
      ADD CONSTRAINT party_access_tokens_party_fk
        FOREIGN KEY (party_id) REFERENCES agreement_parties (id) ON DELETE CASCADE;
  `);

  // DEC-007 — each correction cycle closes a version and opens the next.
  await knex.schema.createTable('agreement_version_history', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.integer('version_no').notNullable();
    t.specificType('status_at_close', 'agreement_status').notNullable();
    t.text('rejection_reason');
    t.integer('superseded_by_version');
    t.integer('voided_signature_count').notNullable().defaultTo(0);
    t.timestamp('closed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['agreement_id', 'version_no']);
  });

  // SRS v1.1 §A8 rule 4 — every transition is recorded, without exception.
  await knex.schema.createTable('workflow_transitions', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.integer('agreement_version').notNullable();
    t.specificType('from_state', 'agreement_status');
    t.specificType('to_state', 'agreement_status').notNullable();
    t.uuid('actor_id').references('id').inTable('users');
    t.specificType('trigger', 'transition_trigger').notNullable();
    t.text('reason');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `CREATE INDEX idx_workflow_transitions_agreement ON workflow_transitions (agreement_id, id)`,
  );

  // BR-005 — a COMPLETED agreement's content is frozen. Enforced at the database so
  // that no code path, including a future migration script, can quietly edit it.
  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION reject_completed_agreement_edit() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'COMPLETED' AND (
           NEW.data              IS DISTINCT FROM OLD.data
        OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
        OR NEW.agreement_type_id IS DISTINCT FROM OLD.agreement_type_id
        OR NEW.agreement_number  IS DISTINCT FROM OLD.agreement_number
        OR NEW.status            IS DISTINCT FROM OLD.status
      ) THEN
        RAISE EXCEPTION 'BR-005: completed agreement % cannot be edited', OLD.agreement_number
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_agreements_completed_immutable
      BEFORE UPDATE ON agreements
      FOR EACH ROW EXECUTE FUNCTION reject_completed_agreement_edit();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS trg_agreements_completed_immutable ON agreements;
    DROP FUNCTION IF EXISTS reject_completed_agreement_edit();
    ALTER TABLE party_access_tokens
      DROP CONSTRAINT IF EXISTS party_access_tokens_agreement_fk,
      DROP CONSTRAINT IF EXISTS party_access_tokens_party_fk;
  `);
  await knex.schema.dropTableIfExists('workflow_transitions');
  await knex.schema.dropTableIfExists('agreement_version_history');
  await knex.schema.dropTableIfExists('agreement_parties');
  await knex.schema.dropTableIfExists('agreements');
}
