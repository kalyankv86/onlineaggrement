import type { Knex } from 'knex';

/**
 * Multiple identifiers per stamp paper — DEC-029.
 *
 * A real Andhra Pradesh SHCIL e-Stamp carries three distinct identifiers:
 *
 *   Certificate No.        IN-AP77702625151064Y
 *   Unique Doc. Reference  SUBIN-APAP1816830336771257804039Y
 *   Paper serial           FH 0001752181
 *
 * With a single `stamp_number` field, two operators recording the same physical
 * stamp under different numbers produce two AVAILABLE records, and BR-006 is
 * defeated without any bug — purely through ambiguity about which number is *the*
 * number. Recording all of them, each independently unique, means getting any one
 * right is enough to catch the duplicate.
 *
 * A table rather than three columns because the identifiers a stamp carries vary
 * by state and by issuer: a traditional vendor paper has only a serial, an
 * e-Stamp has certificate and SUBIN references. New kinds need no schema change.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    /*
     * Deliberately excludes the account reference. On an AP e-Stamp that field
     * reads NEWIMPACC (IV)/ap18168303/AP-VKP/… — the vendor's account, shared by
     * every stamp that vendor issues. Treating it as a per-stamp identifier would
     * reject the second genuine stamp bought from the same vendor. It is stored
     * as an ordinary column below.
     */
    CREATE TYPE stamp_identifier_kind AS ENUM (
      'CERTIFICATE_NO',
      'UNIQUE_DOC_REF',
      'PAPER_SERIAL',
      'OTHER'
    );
  `);

  await knex.schema.createTable('stamp_identifiers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('stamp_paper_id').notNullable().references('id').inTable('stamp_papers').onDelete('CASCADE');
    t.specificType('kind', 'stamp_identifier_kind').notNullable();
    /** Exactly as printed, for display and for comparison against the paper. */
    t.text('value').notNullable();
    /**
     * Uppercase alphanumerics only. Uniqueness is enforced on this, because
     * "IN-AP777…", "INAP777…" and "in-ap 777…" are the same stamp and a raw
     * index would happily accept all three.
     */
    t.text('normalized').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Short values collide by accident rather than by identity.
    t.check("length(normalized) >= 6", undefined, 'stamp_identifiers_min_length');
  });

  await knex.schema.raw(`
    /*
     * Unique across every kind, not per kind. If a value recorded as a paper
     * serial already exists as another stamp's certificate number, that is either
     * the same stamp entered twice or a transcription error — both worth blocking
     * rather than silently permitting.
     */
    CREATE UNIQUE INDEX uq_stamp_identifier_normalized
      ON stamp_identifiers (normalized);

    CREATE INDEX idx_stamp_identifiers_stamp ON stamp_identifiers (stamp_paper_id);

    -- One value of each kind per stamp.
    CREATE UNIQUE INDEX uq_stamp_identifier_kind_per_stamp
      ON stamp_identifiers (stamp_paper_id, kind);
  `);

  /*
   * Backfill the existing stamp_number as a certificate number so the new
   * constraint covers stamps registered before this migration.
   */
  await knex.raw(`
    INSERT INTO stamp_identifiers (stamp_paper_id, kind, value, normalized)
    SELECT id, 'CERTIFICATE_NO', stamp_number,
           upper(regexp_replace(stamp_number, '[^A-Za-z0-9]', '', 'g'))
    FROM stamp_papers
    WHERE stamp_number IS NOT NULL
      AND length(regexp_replace(stamp_number, '[^A-Za-z0-9]', '', 'g')) >= 6
    ON CONFLICT DO NOTHING;
  `);

  // Fields the e-Stamp prints that are worth keeping for cross-checking.
  await knex.schema.alterTable('stamp_papers', (t) => {
    t.string('issuer', 60); // SHCIL, state treasury, licensed vendor
    // Not unique: identifies the vendor account, not the individual stamp.
    t.string('account_reference', 200);
    t.string('ddo_code', 60);
    t.string('document_description', 200); // "Article 7 Agreement"
    t.string('property_description', 200); // "BANK GUARANTEE"
    t.decimal('consideration_price', 14, 2);
    t.string('first_party', 300);
    t.string('second_party', 300);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stamp_papers', (t) => {
    t.dropColumn('issuer');
    t.dropColumn('account_reference');
    t.dropColumn('ddo_code');
    t.dropColumn('document_description');
    t.dropColumn('property_description');
    t.dropColumn('consideration_price');
    t.dropColumn('first_party');
    t.dropColumn('second_party');
  });
  await knex.schema.dropTableIfExists('stamp_identifiers');
  await knex.raw('DROP TYPE IF EXISTS stamp_identifier_kind');
}
