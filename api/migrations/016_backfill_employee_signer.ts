import type { Knex } from 'knex';

/*
 * DEC-034 — backfill the designated employee signer on existing agreement types.
 *
 * Migration 015 added the column. On an already-running deployment it is null,
 * and since an agreement cannot be created without a designated signer, every
 * existing agreement type becomes unusable the moment 015 applies. The seed sets
 * it, but a deployment applies migrations without re-seeding, so the fix has to
 * live here.
 *
 * Deliberately conservative: it backfills ONLY where there is exactly one active
 * user holding the EMPLOYEE role, so there is no choice to get wrong. With none,
 * or with several, the column stays null and agreement creation fails with a
 * message naming what to set — which is the right outcome, because picking a
 * signer by row order is not a defensible way to decide who executes an
 * instrument.
 *
 * A separate migration rather than an edit to 015, so it is correct whether or
 * not 015 has already been applied somewhere.
 */
export async function up(knex: Knex): Promise<void> {
  const employees = await knex('users as u')
    .join('user_roles as ur', 'ur.user_id', 'u.id')
    .join('roles as r', 'r.id', 'ur.role_id')
    .where({ 'r.code': 'EMPLOYEE', 'u.is_active': true })
    .whereNull('u.bank_id')
    .select('u.id', 'u.full_name');

  if (employees.length !== 1) {
    // Nothing to do, and nothing to guess at. Reported so the operator reading
    // the deployment log knows why the column is still null.
    const reason =
      employees.length === 0
        ? 'no active internal user holds the EMPLOYEE role'
        : `${employees.length} users hold the EMPLOYEE role, so the choice is not unambiguous`;
    // eslint-disable-next-line no-console
    console.log(
      `  [016] employee signer not backfilled: ${reason}. ` +
        'Set it per bank under Administration → Banks, or on the agreement type, ' +
        'before creating agreements.',
    );
    return;
  }

  const updated = await knex('agreement_types')
    .whereNull('employee_signer_user_id')
    .update({ employee_signer_user_id: employees[0].id });

  if (updated > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  [016] designated ${employees[0].full_name} as the employee signer on ` +
        `${updated} agreement type(s). Change it per bank under Administration → Banks.`,
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  // The column itself is removed by 015's rollback; clearing it here keeps the
  // two migrations independent.
  await knex('agreement_types')
    .whereNotNull('employee_signer_user_id')
    .update({ employee_signer_user_id: null });
}
