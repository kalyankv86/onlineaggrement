import type { Knex } from 'knex';
// Default import: Node loads this file as ESM, where a namespace import of a
// CommonJS module puts the exports behind `.default`.
import bcrypt from 'bcryptjs';

/**
 * Bootstrap data for development and UAT.
 *
 * The passwords here are deliberately obvious and the seed refuses to run against
 * NODE_ENV=production — seeded credentials in a production register would be a
 * finding on the first security review.
 */
const ROLES = [
  ['SUPER_ADMIN', 'Super Administrator', 'System configuration, roles, templates, integrations'],
  ['AGREEMENT_ADMIN', 'Agreement Administrator', 'Types, templates, stamp inventory, operations'],
  ['AGENT', 'Agent', 'Initiates agreements, enters data, reviews and signs'],
  ['EMPLOYEE', 'Employee', 'Reviews the agent-signed agreement and approves it'],
  ['MD', 'Managing Director', 'Final review and digital signature'],
  ['MD_DELEGATE', 'MD Delegate', 'Time-bounded delegate for MD signature (DEC-014)'],
  ['AUDITOR', 'Auditor', 'Read-only access to agreements, signatures and audit trails'],
];

const PERMISSIONS = [
  'agreement:create', 'agreement:read', 'agreement:generate', 'agreement:cancel', 'agreement:correct',
  'agreement:sign', 'agreement:approve', 'agreement:reject',
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
  AGENT: ['agreement:create', 'agreement:read', 'agreement:generate', 'agreement:sign', 'agreement:correct', 'stamp:allocate'],
  EMPLOYEE: ['agreement:read', 'agreement:approve', 'agreement:reject'],
  MD: ['agreement:read', 'agreement:sign', 'agreement:reject', 'report:read'],
  MD_DELEGATE: ['agreement:read', 'agreement:sign', 'agreement:reject'],
  AUDITOR: ['agreement:read', 'audit:read', 'report:read'],
};

const USERS = [
  ['admin@gtids.example', 'GTIDS Administrator', 'SUPER_ADMIN'],
  ['ops@gtids.example', 'Agreement Operations', 'AGREEMENT_ADMIN'],
  ['agent@gtids.example', 'Ramesh Kumar', 'AGENT'],
  ['employee@gtids.example', 'Sunita Patnaik', 'EMPLOYEE'],
  ['md@gtids.example', 'Dr. A. K. Mohanty', 'MD'],
  ['auditor@gtids.example', 'Internal Auditor', 'AUDITOR'],
];

const DEV_PASSWORD = 'ChangeMe-Dev-2026!';

const TEMPLATE_HTML = `
<h1>Service Engagement Agreement</h1>
<p>This Agreement is made on {{executionDate}} at {{placeOfExecution}} between
Gramtarang Inclusive Development Services ("GTIDS") and {{agentName}} ("the Agent").</p>
<p>Agreement reference {{agreementNumber}}, generated {{generatedAt}}.</p>
<h2>1. Engagement</h2>
<p>The Agent shall provide {{serviceDescription}} for a term of {{termMonths}} months
commencing {{startDate}}.</p>
<h2>2. Consideration</h2>
<p>GTIDS shall pay the Agent {{consideration}} in accordance with the payment schedule
agreed between the parties.</p>
<h2>3. Stamp Duty</h2>
<p>This Agreement is executed on non-judicial stamp paper of Rs.100 as affixed.</p>
<h2>4. Execution</h2>
<p>Executed by the Agent, approved by the authorised Employee of GTIDS, and signed by
the Managing Director, in that order.</p>
`.trim();

/**
 * Idempotent and transactional, both deliberately.
 *
 * Knex does not wrap seeds in a transaction, so an earlier delete-then-recreate
 * version left the database with zero roles when the user delete hit a foreign key
 * from `agreement_template_versions.created_by` — every request then failed
 * authorisation. A seed that can leave the database unusable is worse than no seed
 * at all, so this one upserts rather than deletes, and rolls back as a unit.
 */
export async function seed(knex: Knex): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development data into production');
  }

  await knex.transaction(async (trx) => {
    const roleIds = new Map<string, string>();
    for (const [code, name, description] of ROLES) {
      const [row] = await trx('roles')
        .insert({ code, name, description, is_system: true })
        .onConflict('code')
        .merge(['name', 'description'])
        .returning('id');
      roleIds.set(code, row.id);
    }

    const permissionIds = new Map<string, string>();
    for (const code of PERMISSIONS) {
      const [row] = await trx('permissions')
        .insert({ code })
        .onConflict('code')
        .merge(['code'])
        .returning('id');
      permissionIds.set(code, row.id);
    }

    for (const [roleCode, perms] of Object.entries(ROLE_PERMISSIONS)) {
      await trx('role_permissions')
        .insert(
          perms.map((p) => ({
            role_id: roleIds.get(roleCode),
            permission_id: permissionIds.get(p),
          })),
        )
        .onConflict(['role_id', 'permission_id'])
        .ignore();
    }

    const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);
    const userIds = new Map<string, string>();
    for (const [email, fullName, roleCode] of USERS) {
      const [user] = await trx('users')
        .insert({
          email,
          full_name: fullName,
          password_hash: passwordHash,
          user_type: 'INTERNAL',
          is_active: true,
        })
        .onConflict('email')
        .merge(['full_name', 'password_hash', 'is_active'])
        .returning('id');
      userIds.set(email, user.id);

      await trx('user_roles')
        .insert({ user_id: user.id, role_id: roleIds.get(roleCode) })
        .onConflict(['user_id', 'role_id'])
        .ignore();
    }

    // ── Agreement type, template and SLA ──────────────────────────────────────
    const [type] = await trx('agreement_types')
      .insert({
        code: 'SVCAGR',
        name: 'Service Engagement Agreement',
        description: 'Standard engagement executed on Rs.100 non-judicial stamp paper',
        party_access_mode: 'INTERNAL',
        requires_identity_verification: false,
        requires_stamp: true,
        stamp_denomination: 100,
      })
      .onConflict('code')
      .merge(['name', 'description'])
      .returning('id');

    // DEC-008 — SLA and reminder cadence for each stage that waits on a human.
    await trx('stage_slas')
      .insert(
        ['READY_FOR_AGENT_SIGNATURE', 'PENDING_EMPLOYEE_APPROVAL', 'PENDING_MD_SIGNATURE'].map(
          (stage) => ({
            agreement_type_id: type.id,
            stage,
            sla_days: 14,
            reminder_days: trx.raw(`'{3,7,12}'::integer[]`),
          }),
        ),
      )
      .onConflict(['agreement_type_id', 'stage'])
      .ignore();

    let template = await trx('agreement_templates')
      .where({ agreement_type_id: type.id, name: 'Service Engagement Agreement — standard' })
      .first();
    if (!template) {
      [template] = await trx('agreement_templates')
        .insert({
          agreement_type_id: type.id,
          name: 'Service Engagement Agreement — standard',
          description: 'Seeded template for development',
        })
        .returning('*');
    }

    const existingVersion = await trx('agreement_template_versions')
      .where({ template_id: template.id, version_no: 1 })
      .first();
    if (!existingVersion) {
      await trx('agreement_template_versions').insert({
        template_id: template.id,
        version_no: 1,
        content: TEMPLATE_HTML,
        variables_schema: JSON.stringify({
          required: [
            'executionDate', 'placeOfExecution', 'agentName', 'serviceDescription',
            'termMonths', 'startDate', 'consideration',
          ],
        }),
        // Author and approver differ, mirroring the separation of duties the
        // service enforces on real template approvals.
        status: 'APPROVED',
        created_by: userIds.get('ops@gtids.example'),
        approved_by: userIds.get('admin@gtids.example'),
        approved_at: new Date(),
      });
    }
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${ROLES.length} roles, ${PERMISSIONS.length} permissions, ${USERS.length} users.\n` +
      `Development password for all seeded users: ${DEV_PASSWORD}`,
  );
}
