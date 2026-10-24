import type { Knex } from 'knex';

/*
 * DEC-031..034 — multiple banks, each with its own agreement, and a GTIDS
 * employee signature restored between the Agent and the MD.
 *
 * ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it on
 * PostgreSQL, so this migration runs unwrapped. Each statement is individually
 * idempotent for that reason: a failure halfway leaves a re-runnable state rather
 * than a half-applied one that knex believes succeeded.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // ── Banks (DEC-031) ─────────────────────────────────────────────────────────
  // The counterparty organisation an agent belongs to. Deliberately NOT modelled
  // as an agreement type: the type's code is embedded in every agreement number
  // (FR-026), so a type per bank would push the bank list into the numbering
  // scheme permanently and still not say which agents belong to which bank.
  const hasBanks = await knex.schema.hasTable('banks');
  if (!hasBanks) {
    await knex.schema.createTable('banks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // Short identifier for operators, e.g. UBI. Not used in agreement numbers.
      t.string('code', 20).notNullable();
      t.string('name', 200).notNullable();
      t.string('contact_email', 200);
      t.string('contact_person', 200);
      /*
       * The GTIDS employee who signs this bank's agreements (DEC-034).
       *
       * Held here rather than chosen per agreement: the agent must not be able to
       * pick who countersigns their own instrument. An administrator designates
       * one person per bank, which is also how a relationship manager maps to an
       * institution in practice.
       */
      t.uuid('employee_signer_user_id').references('id').inTable('users');
      t.boolean('is_active').notNullable().defaultTo(true);
      t.uuid('created_by').notNullable().references('id').inTable('users');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });

    // Case-insensitive uniqueness on both. "Union Bank" and "union bank" are the
    // same institution, and an operator creating the second would silently split
    // that bank's agents and documents across two records.
    await knex.raw(`CREATE UNIQUE INDEX uq_banks_code_ci ON banks (upper(code))`);
    await knex.raw(`CREATE UNIQUE INDEX uq_banks_name_ci ON banks (upper(name))`);
  }

  // ── Each bank's agreement document (DEC-032) ────────────────────────────────
  // A fixed PDF per bank, uploaded by an administrator and versioned. The agent
  // never uploads: the document is a property of the bank, so one agent cannot
  // execute a different text from another agent at the same institution.
  const hasDocs = await knex.schema.hasTable('bank_agreement_documents');
  if (!hasDocs) {
    await knex.schema.createTable('bank_agreement_documents', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('bank_id').notNullable().references('id').inTable('banks').onDelete('CASCADE');
      t.integer('version_no').notNullable();
      t.string('original_filename', 300).notNullable();
      t.string('original_content_type', 100).notNullable();
      t.string('file_key', 500).notNullable();
      t.string('file_hash', 64).notNullable();
      // Set once the file has been converted to PDF, if it was not one already.
      t.string('converted_file_key', 500);
      t.string('converted_hash', 64);
      t.integer('page_count');
      t.boolean('is_active').notNullable().defaultTo(false);
      t.uuid('uploaded_by').notNullable().references('id').inTable('users');
      t.timestamp('activated_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['bank_id', 'version_no']);
    });

    /*
     * At most one active document per bank, enforced by the database.
     *
     * This is the invariant the whole feature rests on: if two were active, which
     * text an agent executed would depend on row order. A partial unique index
     * makes that unrepresentable rather than merely unlikely.
     */
    await knex.raw(`
      CREATE UNIQUE INDEX uq_bank_active_document
        ON bank_agreement_documents (bank_id)
        WHERE is_active
    `);
    await knex.raw(`
      ALTER TABLE bank_agreement_documents
        ADD CONSTRAINT ck_bank_doc_activated
        CHECK ((is_active AND activated_at IS NOT NULL) OR NOT is_active)
    `);
  }

  // ── Agents belong to a bank (DEC-031) ───────────────────────────────────────
  if (!(await knex.schema.hasColumn('users', 'bank_id'))) {
    await knex.schema.alterTable('users', (t) => {
      // Nullable: GTIDS's own staff — administrators, employees, the MD, auditors
      // — belong to no bank. The requirement that an AGENT has one is enforced in
      // the service, which is the only layer that can see a user's roles.
      t.uuid('bank_id').references('id').inTable('banks');
      t.index(['bank_id'], 'ix_users_bank');
    });
  }

  // ── An agreement records its bank (DEC-031) ─────────────────────────────────
  if (!(await knex.schema.hasColumn('agreements', 'bank_id'))) {
    await knex.schema.alterTable('agreements', (t) => {
      // Copied from the agent at creation rather than resolved through the user
      // later: an agent who moves to another bank must not retrospectively change
      // which institution an executed agreement was with.
      t.uuid('bank_id').references('id').inTable('banks');
      t.index(['bank_id'], 'ix_agreements_bank');
    });
  }

  if (!(await knex.schema.hasColumn('agreements', 'bank_document_id'))) {
    await knex.schema.alterTable('agreements', (t) => {
      // Which version of that bank's agreement was executed. Pins the text even
      // after the bank's document is superseded.
      t.uuid('bank_document_id').references('id').inTable('bank_agreement_documents');
    });
  }

  // ── The employee signs again (DEC-033) ──────────────────────────────────────
  /*
   * New enum values rather than reuse of the PENDING_EMPLOYEE_APPROVAL family.
   *
   * Those states mean an attested click, which is what DEC-004 decided and
   * DEC-024 removed. The employee now applies a cryptographic signature, which is
   * a different act with different evidentiary weight. State names persist in the
   * audit trail forever, so recording a signature under a name that says
   * "approved" would misdescribe a legal record.
   */
  for (const value of ['PENDING_EMPLOYEE_SIGNATURE', 'EMPLOYEE_SIGNING', 'EMPLOYEE_SIGNED']) {
    await knex.raw(`ALTER TYPE agreement_status ADD VALUE IF NOT EXISTS '${value}'`);
  }

  /*
   * The same distinction for the document itself. `EMPLOYEE_ATTESTED` records
   * DEC-004's click; a document carrying the employee's cryptographic signature
   * is in a different state, and the stored document's type is what a later
   * reader uses to tell which signatures it should contain.
   */
  await knex.raw(`ALTER TYPE signature_state ADD VALUE IF NOT EXISTS 'EMPLOYEE_SIGNED'`);
  await knex.raw(`ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'EMPLOYEE_SIGNED'`);

  /*
   * The same designation for agreements that belong to no bank — GTIDS's own
   * engagements. Resolution is bank first, then type, so a bank agreement always
   * uses the bank's signer and nothing silently falls back.
   */
  if (!(await knex.schema.hasColumn('agreement_types', 'employee_signer_user_id'))) {
    await knex.schema.alterTable('agreement_types', (t) => {
      t.uuid('employee_signer_user_id').references('id').inTable('users');
    });
  }

  // A bank-supplied document is a third source, alongside UPLOAD and TEMPLATE.
  await knex.raw(`
    UPDATE agreement_types SET document_source = 'BANK_DOCUMENT'
     WHERE document_source = 'UPLOAD'
       AND EXISTS (SELECT 1 FROM banks)
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Enum values cannot be removed in PostgreSQL. The states added above remain in
  // the type after a rollback; they are simply unreachable again, exactly as the
  // EMPLOYEE_APPROVAL family was between DEC-024 and DEC-033.
  await knex.raw(`UPDATE agreement_types SET document_source = 'UPLOAD'
                   WHERE document_source = 'BANK_DOCUMENT'`);

  if (await knex.schema.hasColumn('agreement_types', 'employee_signer_user_id')) {
    await knex.schema.alterTable('agreement_types', (t) =>
      t.dropColumn('employee_signer_user_id'),
    );
  }
  if (await knex.schema.hasColumn('agreements', 'bank_document_id')) {
    await knex.schema.alterTable('agreements', (t) => t.dropColumn('bank_document_id'));
  }
  if (await knex.schema.hasColumn('agreements', 'bank_id')) {
    await knex.schema.alterTable('agreements', (t) => t.dropColumn('bank_id'));
  }
  if (await knex.schema.hasColumn('users', 'bank_id')) {
    await knex.schema.alterTable('users', (t) => t.dropColumn('bank_id'));
  }
  await knex.schema.dropTableIfExists('bank_agreement_documents');
  await knex.schema.dropTableIfExists('banks');
}
