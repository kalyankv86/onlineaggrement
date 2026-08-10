import type { Knex } from 'knex';

/**
 * System roles and permissions.
 *
 * These are reference data the application cannot function without, not sample
 * data — so they belong in a migration rather than a seed. The seed refuses to
 * run with NODE_ENV=production (it creates known-password demo users), which
 * meant a freshly provisioned production database had no roles at all and every
 * request failed authorisation with no obvious cause.
 *
 * Idempotent: re-running updates names and descriptions and adds anything new,
 * without disturbing existing grants.
 */
const ROLES: [string, string, string][] = [
  ['SUPER_ADMIN', 'Super Administrator', 'System configuration, roles, templates, integrations'],
  ['AGREEMENT_ADMIN', 'Agreement Administrator', 'Types, templates, stamp inventory, operations'],
  ['AGENT', 'Agent', 'Initiates agreements, enters data, reviews and signs'],
  ['EMPLOYEE', 'Employee', 'Reviews the agent-signed agreement and approves it'],
  ['MD', 'Managing Director', 'Final review and digital signature'],
  ['MD_DELEGATE', 'MD Delegate', 'Time-bounded delegate for MD signature (DEC-014)'],
  ['AUDITOR', 'Auditor', 'Read-only access to agreements, signatures and audit trails'],
];

const PERMISSIONS = [
  'agreement:create', 'agreement:read', 'agreement:generate', 'agreement:cancel',
  'agreement:correct', 'agreement:sign', 'agreement:approve', 'agreement:reject',
  'template:manage', 'template:approve',
  'stamp:manage', 'stamp:allocate',
  'audit:read', 'report:read', 'user:manage', 'role:manage',
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  SUPER_ADMIN: PERMISSIONS,
  AGREEMENT_ADMIN: [
    'agreement:create', 'agreement:read', 'agreement:generate', 'agreement:cancel',
    'agreement:correct', 'template:manage', 'template:approve', 'stamp:manage',
    'stamp:allocate', 'report:read', 'audit:read',
  ],
  AGENT: [
    'agreement:create', 'agreement:read', 'agreement:generate', 'agreement:sign',
    'agreement:correct', 'stamp:allocate',
  ],
  EMPLOYEE: ['agreement:read', 'agreement:approve', 'agreement:reject'],
  MD: ['agreement:read', 'agreement:sign', 'agreement:reject', 'report:read'],
  MD_DELEGATE: ['agreement:read', 'agreement:sign', 'agreement:reject'],
  AUDITOR: ['agreement:read', 'audit:read', 'report:read'],
};

export async function up(knex: Knex): Promise<void> {
  const roleIds = new Map<string, string>();
  for (const [code, name, description] of ROLES) {
    const [row] = await knex('roles')
      .insert({ code, name, description, is_system: true })
      .onConflict('code')
      .merge(['name', 'description', 'is_system'])
      .returning('id');
    roleIds.set(code, row.id);
  }

  const permissionIds = new Map<string, string>();
  for (const code of PERMISSIONS) {
    const [row] = await knex('permissions')
      .insert({ code })
      .onConflict('code')
      .merge(['code'])
      .returning('id');
    permissionIds.set(code, row.id);
  }

  for (const [roleCode, perms] of Object.entries(ROLE_PERMISSIONS)) {
    await knex('role_permissions')
      .insert(
        perms.map((p) => ({ role_id: roleIds.get(roleCode), permission_id: permissionIds.get(p) })),
      )
      .onConflict(['role_id', 'permission_id'])
      .ignore();
  }
}

export async function down(knex: Knex): Promise<void> {
  // Only the grants and the system roles themselves; user_roles cascade.
  await knex('role_permissions').delete();
  await knex('permissions').whereIn('code', PERMISSIONS).delete();
  await knex('roles').whereIn('code', ROLES.map((r) => r[0])).delete();
}
