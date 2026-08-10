import type { Knex } from 'knex';

/**
 * Stamp inventory and allocation (FR-005, FR-006, BR-006, DEC-009).
 *
 * The exclusivity guarantee lives in the partial unique index below, not in the
 * service layer. Application-level "check then insert" cannot survive two
 * concurrent requests, let alone two API instances.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('stamp_papers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('stamp_number', 100);
    t.decimal('denomination', 12, 2).notNullable();
    t.string('state_code', 10).notNullable(); // ISO 3166-2:IN, SRS v1.1 §7.2
    t.date('issue_date');
    t.string('vendor', 200);
    t.string('file_key', 500).notNullable(); // object-storage key of the scan
    t.string('document_hash', 64).notNullable(); // SHA-256 of the uploaded scan
    t.specificType('status', 'stamp_status').notNullable().defaultTo('AVAILABLE');
    t.uuid('created_by').notNullable().references('id').inTable('users');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check('denomination > 0', undefined, 'stamp_papers_denomination_positive');
  });

  // Stamp numbers are unique where recorded; some vendors do not print one.
  await knex.schema.raw(`
    CREATE UNIQUE INDEX uq_stamp_number ON stamp_papers (stamp_number)
      WHERE stamp_number IS NOT NULL;
    CREATE INDEX idx_stamp_papers_available ON stamp_papers (denomination, state_code)
      WHERE status = 'AVAILABLE';
  `);

  await knex.schema.createTable('stamp_allocations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('stamp_paper_id').notNullable().references('id').inTable('stamp_papers');
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.uuid('allocated_by').notNullable().references('id').inTable('users');
    t.timestamp('allocated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('released_at', { useTz: true });
    t.text('released_reason');
  });

  await knex.schema.raw(`
    -- BR-006 / DEC-009: at most one live allocation per stamp, ever, under any
    -- level of concurrency. AC-11 tests 50 parallel attempts against this.
    CREATE UNIQUE INDEX uq_stamp_active_allocation
      ON stamp_allocations (stamp_paper_id)
      WHERE released_at IS NULL;

    -- An agreement holds at most one live stamp.
    CREATE UNIQUE INDEX uq_agreement_active_allocation
      ON stamp_allocations (agreement_id)
      WHERE released_at IS NULL;

    CREATE INDEX idx_stamp_allocations_agreement ON stamp_allocations (agreement_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stamp_allocations');
  await knex.schema.dropTableIfExists('stamp_papers');
}
