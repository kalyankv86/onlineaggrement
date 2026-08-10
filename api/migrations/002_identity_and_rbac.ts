import type { Knex } from 'knex';

/** Users, RBAC, MD delegation and external party access (DEC-003, DEC-014). */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.specificType('email', 'citext').notNullable().unique();
    t.string('full_name', 200).notNullable();
    t.string('mobile', 20);
    // Null for EXTERNAL principals — they never hold a standing credential.
    t.string('password_hash', 200);
    t.specificType('user_type', 'user_type').notNullable().defaultTo('INTERNAL');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.text('mfa_secret'); // encrypted at rest by the application
    t.timestamp('mfa_enrolled_at', { useTz: true });
    t.timestamp('last_login_at', { useTz: true });
    t.integer('failed_login_count').notNullable().defaultTo(0);
    t.timestamp('locked_until', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      `(user_type = 'EXTERNAL') OR (password_hash IS NOT NULL)`,
      undefined,
      'users_internal_requires_password',
    );
  });

  await knex.schema.createTable('roles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('code', 50).notNullable().unique();
    t.string('name', 100).notNullable();
    t.text('description');
    t.boolean('is_system').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('permissions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('code', 100).notNullable().unique(); // resource:action
    t.text('description');
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.uuid('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.uuid('permission_id').notNullable().references('id').inTable('permissions').onDelete('CASCADE');
    t.primary(['role_id', 'permission_id']);
  });

  await knex.schema.createTable('user_roles', (t) => {
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.uuid('granted_by').references('id').inTable('users');
    t.timestamp('granted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'role_id']);
  });

  // DEC-014 — bounded MD delegation, no two active at once.
  await knex.schema.createTable('md_delegations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('delegate_user_id').notNullable().references('id').inTable('users');
    t.uuid('appointed_by').notNullable().references('id').inTable('users');
    t.date('valid_from').notNullable();
    t.date('valid_to').notNullable();
    t.timestamp('revoked_at', { useTz: true });
    t.text('reason').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.check('valid_to >= valid_from', undefined, 'md_delegations_valid_range');
  });

  await knex.raw(`
    ALTER TABLE md_delegations
      ADD CONSTRAINT md_delegations_no_overlap
      EXCLUDE USING gist (
        daterange(valid_from, valid_to, '[]') WITH &&
      ) WHERE (revoked_at IS NULL);
  `);

  // DEC-003 — single-use, expiring access for external parties.
  await knex.schema.createTable('party_access_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('agreement_id').notNullable(); // FK added in 004 once agreements exists
    t.uuid('party_id').notNullable();
    // The token itself is NEVER stored — only its SHA-256.
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
    t.specificType('issued_to_ip', 'inet');
    t.uuid('issued_by').references('id').inTable('users');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `CREATE INDEX idx_party_access_tokens_agreement ON party_access_tokens (agreement_id)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('party_access_tokens');
  await knex.schema.dropTableIfExists('md_delegations');
  await knex.schema.dropTableIfExists('user_roles');
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('permissions');
  await knex.schema.dropTableIfExists('roles');
  await knex.schema.dropTableIfExists('users');
}
