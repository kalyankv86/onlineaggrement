import type { Knex } from 'knex';

/**
 * Document versions and object-storage references (SDD v1.1 §B8).
 *
 * Every object is written once and never modified — a new state produces a new
 * object. The unique index on file_key is what makes that structural rather than
 * conventional.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agreement_versions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.integer('version_no').notNullable();
    t.specificType('signature_state', 'signature_state').notNullable();
    t.string('document_hash', 64).notNullable();
    t.string('file_key', 500).notNullable();
    t.uuid('supersedes_id').references('id').inTable('agreement_versions');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['agreement_id', 'version_no', 'signature_state']);
  });

  await knex.schema.raw(
    `CREATE INDEX idx_agreement_versions_agreement ON agreement_versions (agreement_id, version_no)`,
  );

  await knex.schema.createTable('agreement_documents', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.uuid('agreement_version_id').references('id').inTable('agreement_versions');
    t.specificType('doc_type', 'document_type').notNullable();
    t.string('file_key', 500).notNullable().unique(); // write-once
    t.string('content_type', 100).notNullable().defaultTo('application/pdf');
    t.bigInteger('size_bytes').notNullable();
    t.string('document_hash', 64).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(`
    CREATE INDEX idx_agreement_documents_agreement ON agreement_documents (agreement_id, doc_type);
  `);

  // Documents are immutable once written (SDD v1.1 §B8 rule 1).
  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION reject_document_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'agreement_documents rows are write-once (SDD v1.1 B8)'
        USING ERRCODE = 'check_violation';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_agreement_documents_immutable
      BEFORE UPDATE OR DELETE ON agreement_documents
      FOR EACH ROW EXECUTE FUNCTION reject_document_mutation();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS trg_agreement_documents_immutable ON agreement_documents;
    DROP FUNCTION IF EXISTS reject_document_mutation();
  `);
  await knex.schema.dropTableIfExists('agreement_documents');
  await knex.schema.dropTableIfExists('agreement_versions');
}
