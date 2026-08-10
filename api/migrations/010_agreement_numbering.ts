import type { Knex } from 'knex';

/**
 * Agreement numbering — FR-026 / DEC-018.
 *
 * Format: GTIDS/{financial-year}/{type-code}/{6-digit sequence}
 * e.g.    GTIDS/2026-27/EMPAGR/000042
 *
 * A Postgres SEQUENCE is deliberately NOT used: sequences are non-transactional
 * and leave gaps on rollback, and a gap in a legal register invites the question
 * "what was agreement 41?". A locked counter row trades a little concurrency for
 * a gap-free register, which is the right trade at 200 agreements/day.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agreement_number_sequences', (t) => {
    t.string('financial_year', 9).notNullable(); // '2026-27'
    t.string('type_code', 20).notNullable();
    t.integer('next_value').notNullable().defaultTo(1);
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['financial_year', 'type_code']);
  });

  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION next_agreement_number(p_fy text, p_type_code text)
      RETURNS text AS $$
    DECLARE
      v_next integer;
    BEGIN
      INSERT INTO agreement_number_sequences (financial_year, type_code, next_value)
        VALUES (p_fy, p_type_code, 1)
        ON CONFLICT (financial_year, type_code) DO NOTHING;

      UPDATE agreement_number_sequences
         SET next_value = next_value + 1, updated_at = now()
       WHERE financial_year = p_fy AND type_code = p_type_code
      RETURNING next_value - 1 INTO v_next;

      RETURN 'GTIDS/' || p_fy || '/' || p_type_code || '/' || lpad(v_next::text, 6, '0');
    END;
    $$ LANGUAGE plpgsql;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP FUNCTION IF EXISTS next_agreement_number(text, text)');
  await knex.schema.dropTableIfExists('agreement_number_sequences');
}
