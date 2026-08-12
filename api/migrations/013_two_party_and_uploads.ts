import type { Knex } from 'knex';

/**
 * GTIDS revised workflow — DEC-024 … DEC-028.
 *
 * Agent signs → MD signs. Agreements are uploaded rather than generated from a
 * template. Stamp details are read by OCR and confirmed. Accounts receives a copy
 * on completion.
 *
 * Nothing is dropped. The Employee states remain in `agreement_status` and
 * existing rows keep their history: an agreement executed under the three-party
 * rules is still a valid record of what happened, and deleting the states it
 * passed through would make its audit trail unreadable. The change is in the
 * transition table, which no longer offers those edges.
 */
export async function up(knex: Knex): Promise<void> {
  // ── Accounts as a notification-only party (DEC-028) ────────────────────────
  await knex.raw(`ALTER TYPE party_type ADD VALUE IF NOT EXISTS 'ACCOUNTS'`);

  // ── Uploaded and composed documents (DEC-025, DEC-027) ─────────────────────
  await knex.raw(`ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'UPLOADED_SOURCE'`);
  await knex.raw(`ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'COMPOSED_UNSIGNED'`);

  // A template is no longer required, because the agreement text now arrives as
  // an uploaded document.
  await knex.schema.alterTable('agreements', (t) => {
    t.uuid('template_version_id').nullable().alter();
  });

  await knex.schema.alterTable('agreement_types', (t) => {
    // How the executable document is produced for this type.
    t.string('document_source', 20).notNullable().defaultTo('UPLOAD'); // UPLOAD | TEMPLATE
    // Where the completion copy goes (DEC-028). Per type, so different agreement
    // classes can report to different mailboxes.
    t.specificType('accounts_email', 'citext');
  });

  // ── The uploaded source document (DEC-025) ─────────────────────────────────
  // Kept as a first-class record: with no template, this file is the only thing
  // that explains what the executed agreement says.
  await knex.schema.createTable('agreement_source_documents', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable().references('id').inTable('agreements').onDelete('CASCADE');
    t.integer('agreement_version').notNullable();
    t.string('original_filename', 300).notNullable();
    t.string('original_content_type', 100).notNullable();
    t.string('original_file_key', 500).notNullable();
    t.string('original_hash', 64).notNullable();
    // Set when a .docx was converted; null when a PDF was uploaded directly.
    t.string('converted_file_key', 500);
    t.string('converted_hash', 64);
    t.integer('page_count');
    t.uuid('uploaded_by').notNullable().references('id').inTable('users');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['agreement_id', 'agreement_version']);
  });

  // ── OCR results, retained as evidence (DEC-026) ────────────────────────────
  // What the machine read and what the human changed it to. If a stamp number is
  // ever disputed, the correction is part of the record rather than invisible.
  await knex.schema.createTable('stamp_ocr_readings', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('stamp_paper_id').references('id').inTable('stamp_papers').onDelete('CASCADE');
    t.string('file_key', 500).notNullable();
    t.text('raw_text');
    t.jsonb('extracted').notNullable().defaultTo('{}');
    t.jsonb('confirmed').notNullable().defaultTo('{}');
    t.boolean('was_corrected').notNullable().defaultTo(false);
    t.uuid('confirmed_by').references('id').inTable('users');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `CREATE INDEX idx_stamp_ocr_stamp ON stamp_ocr_readings (stamp_paper_id)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stamp_ocr_readings');
  await knex.schema.dropTableIfExists('agreement_source_documents');
  await knex.schema.alterTable('agreement_types', (t) => {
    t.dropColumn('document_source');
    t.dropColumn('accounts_email');
  });
  // Enum values are not removed: Postgres cannot drop them, and rows may use them.
}
