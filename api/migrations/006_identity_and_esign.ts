import type { Knex } from 'knex';

/** Pre-signature KYC (narrowed by DEC-005), signing transactions and the callback ledger. */
export async function up(knex: Knex): Promise<void> {
  // FR-007 as amended: pre-signature KYC only. The Aadhaar OTP inside the eSign
  // ceremony belongs to esign_transactions, not here (DEC-005).
  await knex.schema.createTable('identity_verifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.uuid('party_id').notNullable().references('id').inTable('agreement_parties').onDelete('CASCADE');
    t.string('provider', 50).notNullable();
    t.string('provider_transaction_id', 200).notNullable();
    t.specificType('method', 'identity_method').notNullable();
    t.string('status', 30).notNullable();
    // Masked only, e.g. "XXXXXXXX1234". Never the full Aadhaar number (SRS §12).
    t.string('masked_reference', 50);
    t.timestamp('initiated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at', { useTz: true });
    t.string('failure_code', 100);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // DEC-017 — schema ships in v1, module unwired until v1.1.
  await knex.schema.createTable('digilocker_transactions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.uuid('party_id').notNullable().references('id').inTable('agreement_parties').onDelete('CASCADE');
    t.string('consent_artifact_id', 200);
    t.text('document_uri');
    t.string('status', 30).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('esign_transactions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.uuid('party_id').notNullable().references('id').inTable('agreement_parties').onDelete('CASCADE');
    t.integer('agreement_version').notNullable();
    t.string('provider', 50).notNullable();
    t.string('provider_transaction_id', 200).notNullable();
    // The digest sent to the ESP. In the hash-based model (DEC-002) this is the
    // ONLY thing about the document that leaves GTIDS.
    t.string('byte_range_digest', 64);
    t.string('document_hash', 64).notNullable();
    t.specificType('status', 'esign_status').notNullable().defaultTo('INITIATED');
    t.integer('attempt_no').notNullable().defaultTo(1);
    t.string('failure_code', 100);
    t.string('signer_cert_subject', 500);
    t.string('signer_cert_serial', 100);
    t.timestamp('initiated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at', { useTz: true });
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['provider', 'provider_transaction_id']);
  });

  await knex.schema.raw(`
    CREATE INDEX idx_esign_tx_agreement ON esign_transactions (agreement_id);
    -- Drives the reconciliation job (FR-024): only transactions still in flight.
    CREATE INDEX idx_esign_tx_open ON esign_transactions (status, initiated_at)
      WHERE status IN ('INITIATED','PENDING_SIGNER');
    -- At most one live signing attempt per party per agreement version.
    CREATE UNIQUE INDEX uq_esign_open_per_party
      ON esign_transactions (agreement_id, party_id, agreement_version)
      WHERE status IN ('INITIATED','PENDING_SIGNER');
  `);

  // DEC-010 — the idempotency ledger. Unmatched events are still recorded, because
  // an event we cannot match is exactly the kind of thing an operator needs to see.
  await knex.schema.createTable('esign_callback_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('esign_transaction_id').references('id').inTable('esign_transactions');
    t.string('provider', 50).notNullable();
    t.string('provider_event_id', 200).notNullable();
    t.jsonb('raw_payload').notNullable();
    t.boolean('signature_valid').notNullable();
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('processed_at', { useTz: true });
    t.specificType('outcome', 'callback_outcome');
    t.unique(['provider', 'provider_event_id']); // replay protection
  });

  await knex.schema.createTable('signature_events', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.uuid('party_id').notNullable().references('id').inTable('agreement_parties').onDelete('CASCADE');
    t.integer('agreement_version').notNullable();
    t.specificType('event_type', 'signature_event_type').notNullable();
    // The hash the actor actually saw — the basis of stale-view protection (FR-027).
    t.string('document_hash', 64).notNullable();
    t.uuid('esign_transaction_id').references('id').inTable('esign_transactions'); // null for ATTESTED
    t.specificType('ip_address', 'inet');
    t.text('user_agent');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `CREATE INDEX idx_signature_events_agreement ON signature_events (agreement_id, id)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('signature_events');
  await knex.schema.dropTableIfExists('esign_callback_events');
  await knex.schema.dropTableIfExists('esign_transactions');
  await knex.schema.dropTableIfExists('digilocker_transactions');
  await knex.schema.dropTableIfExists('identity_verifications');
}
