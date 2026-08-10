import type { Knex } from 'knex';

/** Audit chain, notifications with per-recipient delivery state, and the outbox. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('agreement_id').references('id').inTable('agreements').onDelete('RESTRICT');
    t.integer('agreement_version');
    t.uuid('actor_id').references('id').inTable('users');
    t.string('event_type', 100).notNullable();
    t.jsonb('event_data').notNullable().defaultTo('{}');
    t.specificType('ip_address', 'inet');
    t.text('user_agent');
    t.string('prev_hash', 64).notNullable().defaultTo('');
    t.string('row_hash', 64).notNullable().defaultTo('');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(`
    CREATE INDEX idx_audit_logs_agreement ON audit_logs (agreement_id, id);
    CREATE INDEX idx_audit_logs_event ON audit_logs (event_type, created_at);
    CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, created_at);
  `);

  // No FK: system-level events with no agreement chain under the nil UUID.
  await knex.schema.createTable('audit_chain_heads', (t) => {
    t.uuid('agreement_id').primary();
    t.string('head_hash', 64).notNullable();
    t.bigInteger('record_count').notNullable().defaultTo(0);
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('notifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').references('id').inTable('agreements').onDelete('CASCADE');
    t.string('event_type', 50).notNullable();
    t.string('subject', 300).notNullable();
    t.string('template_code', 50).notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('dispatched_at', { useTz: true });
  });

  // SDD §12 requires three recipient records on completion; delivery state is
  // per-recipient because one bounce must not mask two successes.
  await knex.schema.createTable('notification_recipients', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('notification_id').notNullable().references('id').inTable('notifications').onDelete('CASCADE');
    t.uuid('party_id').references('id').inTable('agreement_parties');
    t.specificType('email', 'citext').notNullable();
    t.specificType('status', 'notification_status').notNullable().defaultTo('QUEUED');
    t.string('provider_message_id', 300);
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('delivered_at', { useTz: true });
    t.text('failure_reason');
    t.integer('attempt_count').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(`
    CREATE INDEX idx_notification_recipients_pending
      ON notification_recipients (status, created_at)
      WHERE status IN ('QUEUED','FAILED');
  `);

  /*
   * Transactional outbox (SDD v1.1 §B9). Written inside the finalization
   * transaction and dispatched after commit, so BR-008 holds in both directions:
   * no completion email without a committed completion, and no committed
   * completion without an email eventually being sent.
   */
  await knex.schema.createTable('outbox_events', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('aggregate_id');
    t.string('event_type', 100).notNullable();
    t.jsonb('payload').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('processed_at', { useTz: true });
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
  });

  await knex.schema.raw(`
    CREATE INDEX idx_outbox_unprocessed ON outbox_events (created_at)
      WHERE processed_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('outbox_events');
  await knex.schema.dropTableIfExists('notification_recipients');
  await knex.schema.dropTableIfExists('notifications');
  await knex.schema.dropTableIfExists('audit_chain_heads');
  await knex.schema.dropTableIfExists('audit_logs');
}
