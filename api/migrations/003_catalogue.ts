import type { Knex } from 'knex';

/** Agreement types, templates, template versions and per-stage SLAs (FR-003, DEC-008). */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agreement_types', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('code', 20).notNullable().unique(); // appears in the agreement number (FR-026)
    t.string('name', 200).notNullable();
    t.text('description');
    t.specificType('party_access_mode', 'party_access_mode').notNullable().defaultTo('INTERNAL');
    t.boolean('requires_identity_verification').notNullable().defaultTo(false);
    t.boolean('requires_stamp').notNullable().defaultTo(true);
    t.decimal('stamp_denomination', 12, 2).notNullable().defaultTo(100);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('agreement_templates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_type_id').notNullable().references('id').inTable('agreement_types');
    t.string('name', 200).notNullable();
    t.text('description');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('agreement_template_versions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('template_id').notNullable().references('id').inTable('agreement_templates').onDelete('CASCADE');
    t.integer('version_no').notNullable();
    t.text('content').notNullable(); // HTML with {{variable}} placeholders
    t.jsonb('variables_schema').notNullable().defaultTo('{}');
    t.specificType('status', 'template_status').notNullable().defaultTo('DRAFT');
    t.uuid('approved_by').references('id').inTable('users');
    t.timestamp('approved_at', { useTz: true });
    t.uuid('created_by').notNullable().references('id').inTable('users');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['template_id', 'version_no']);
  });

  // Only APPROVED template versions may be instantiated — enforced in the service
  // layer and asserted by test; a retired version stays readable for old agreements.
  await knex.schema.raw(`
    CREATE INDEX idx_template_versions_approved
      ON agreement_template_versions (template_id)
      WHERE status = 'APPROVED';
  `);

  // DEC-008 — per-type, per-stage SLA and reminder cadence.
  await knex.schema.createTable('stage_slas', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_type_id').notNullable().references('id').inTable('agreement_types').onDelete('CASCADE');
    t.specificType('stage', 'agreement_status').notNullable();
    t.integer('sla_days').notNullable().defaultTo(14);
    t.specificType('reminder_days', 'integer[]').notNullable().defaultTo(knex.raw(`'{3,7,12}'::integer[]`));
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['agreement_type_id', 'stage']);
    t.check('sla_days > 0', undefined, 'stage_slas_positive');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stage_slas');
  await knex.schema.dropTableIfExists('agreement_template_versions');
  await knex.schema.dropTableIfExists('agreement_templates');
  await knex.schema.dropTableIfExists('agreement_types');
}
