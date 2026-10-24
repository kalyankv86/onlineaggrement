import type { Knex } from 'knex';

/*
 * DEC-036 — a per-agent execution reference, minted when an agreement completes.
 *
 * `agreement_number` is already globally unique, but it is allocated at creation
 * and says nothing about who executed the agreement: GTIDS/2026-27/SVCAGR/000025
 * is the twenty-fifth service agreement of the year, by anyone, at any bank.
 * GTIDS asked for an identifier per agreement per agent.
 *
 * Deliberately a SECOND identifier rather than a change to the first. The
 * agreement number is on records already issued and is referenced by FR-026;
 * re-formatting it would split the register, and it cannot carry the agent
 * anyway, because the agent is not known to be final until the agreement is.
 */
export async function up(knex: Knex): Promise<void> {
  // ── A stable short code per agent ───────────────────────────────────────────
  if (!(await knex.schema.hasColumn('users', 'agent_code'))) {
    await knex.schema.alterTable('users', (t) => {
      /*
       * Short, stable, and never reused. It appears in a reference that outlives
       * the account, so deactivating an agent must not free their code for
       * someone else — two agreements would then carry the same reference for
       * different people.
       */
      t.string('agent_code', 12);
    });
    await knex.raw(`CREATE UNIQUE INDEX uq_users_agent_code ON users (agent_code)
                      WHERE agent_code IS NOT NULL`);
  }

  // ── The reference itself ────────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('agreements', 'execution_reference'))) {
    await knex.schema.alterTable('agreements', (t) => {
      // Null until completion. An agreement that was never executed has no
      // execution reference, which is the point of the distinction.
      t.string('execution_reference', 60);
    });
    await knex.raw(`CREATE UNIQUE INDEX uq_agreements_execution_reference
                      ON agreements (execution_reference)
                      WHERE execution_reference IS NOT NULL`);
  }

  // Per-agent, per-financial-year counters.
  if (!(await knex.schema.hasTable('agent_execution_sequences'))) {
    await knex.schema.createTable('agent_execution_sequences', (t) => {
      t.string('agent_code', 12).notNullable();
      t.string('financial_year', 7).notNullable();
      t.integer('next_value').notNullable().defaultTo(1);
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['agent_code', 'financial_year']);
    });
  }

  /*
   * Allocated by the database, for the same reason agreement numbers are: two
   * agreements completing at the same instant must not receive the same
   * reference, and a counter read-then-written in application code gives exactly
   * that under concurrency. The UPDATE ... RETURNING takes a row lock.
   */
  await knex.raw(`
    CREATE OR REPLACE FUNCTION next_execution_reference(
      p_bank_code  text,
      p_agent_code text,
      p_fy         text
    ) RETURNS text AS $$
    DECLARE
      v_next integer;
    BEGIN
      INSERT INTO agent_execution_sequences (agent_code, financial_year, next_value)
        VALUES (p_agent_code, p_fy, 1)
        ON CONFLICT (agent_code, financial_year) DO NOTHING;

      UPDATE agent_execution_sequences
         SET next_value = next_value + 1, updated_at = now()
       WHERE agent_code = p_agent_code AND financial_year = p_fy
      RETURNING next_value - 1 INTO v_next;

      RETURN upper(p_bank_code) || '/' || upper(p_agent_code) || '/' || p_fy
             || '/' || lpad(v_next::text, 3, '0');
    END;
    $$ LANGUAGE plpgsql;
  `);

  /*
   * Assign a code to every existing agent.
   *
   * Sequential on creation order so the codes are stable across re-runs, and
   * independent of the bank: an agent who moves institutions keeps their code,
   * because it identifies the person, not where they work.
   */
  const agents = await knex('users as u')
    .join('user_roles as ur', 'ur.user_id', 'u.id')
    .join('roles as r', 'r.id', 'ur.role_id')
    .where('r.code', 'AGENT')
    .whereNull('u.agent_code')
    .orderBy('u.created_at')
    .select('u.id');

  if (agents.length > 0) {
    const [{ max }] = await knex('users')
      .whereNotNull('agent_code')
      .select(
        knex.raw(
          `coalesce(max(nullif(regexp_replace(agent_code, '\\D', '', 'g'), '')::int), 0) as max`,
        ),
      );
    let n = Number(max);
    for (const agent of agents) {
      n += 1;
      await knex('users')
        .where('id', agent.id)
        .update({ agent_code: `AG${String(n).padStart(4, '0')}` });
    }
    // eslint-disable-next-line no-console
    console.log(`  [017] assigned an agent code to ${agents.length} existing agent(s).`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP FUNCTION IF EXISTS next_execution_reference(text, text, text)');
  await knex.schema.dropTableIfExists('agent_execution_sequences');
  if (await knex.schema.hasColumn('agreements', 'execution_reference')) {
    await knex.schema.alterTable('agreements', (t) => t.dropColumn('execution_reference'));
  }
  if (await knex.schema.hasColumn('users', 'agent_code')) {
    await knex.schema.alterTable('users', (t) => t.dropColumn('agent_code'));
  }
}
