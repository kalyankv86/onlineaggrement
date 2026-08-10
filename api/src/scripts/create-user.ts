/**
 * Create or update an internal user — the way the first administrator is made on
 * a production server, where the seed deliberately refuses to run.
 *
 *   cd /opt/gtids-agreements/current/api
 *   sudo -u gtids bash -c 'set -a && . /etc/gtids/api.env && set +a && \
 *     node dist/scripts/create-user.js --email ops@gtids.org --name "A. Nayak" --role SUPER_ADMIN'
 *
 * Options:
 *   --email    required
 *   --name     required on creation
 *   --role     one of SUPER_ADMIN AGREEMENT_ADMIN AGENT EMPLOYEE MD MD_DELEGATE AUDITOR
 *              (repeatable)
 *   --password optional; a strong one is generated and printed if omitted
 *   --deactivate  disable the account instead of creating it
 *
 * The generated password is printed once and never stored in clear. Hand it over
 * out of band and have the holder change it.
 */
import knexLib from 'knex';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

const VALID_ROLES = [
  'SUPER_ADMIN', 'AGREEMENT_ADMIN', 'AGENT', 'EMPLOYEE', 'MD', 'MD_DELEGATE', 'AUDITOR',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) out.push(process.argv[i + 1]);
  });
  return out;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Readable, high-entropy, and safe to send over a channel that mangles symbols. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}

async function main(): Promise<void> {
  const email = arg('email');
  if (!email) throw new Error('--email is required');

  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set — source /etc/gtids/api.env first');

  const knex = knexLib({ client: 'pg', connection: databaseUrl, pool: { min: 1, max: 2 } });

  try {
    if (flag('deactivate')) {
      const count = await knex('users').where('email', email).update({ is_active: false });
      console.log(count ? `Deactivated ${email}` : `No such user: ${email}`);
      return;
    }

    const roles = args('role');
    for (const r of roles) {
      if (!VALID_ROLES.includes(r)) {
        throw new Error(`Unknown role "${r}". Valid: ${VALID_ROLES.join(', ')}`);
      }
    }

    // The roles come from migration 012. If they are absent the database has not
    // been migrated, and creating a user would produce an account that can do
    // nothing — say so rather than half-succeed.
    const known = await knex('roles').pluck<string[]>('code');
    if (known.length === 0) {
      throw new Error('No roles exist. Run migrations first: npm run migrate');
    }

    const existing = await knex('users').where('email', email).first();
    const password = arg('password') ?? (existing ? undefined : generatePassword());

    if (password && password.length < 12) {
      throw new Error('Password must be at least 12 characters');
    }

    let userId: string;
    if (existing) {
      userId = existing.id;
      const patch: Record<string, unknown> = { is_active: true, updated_at: new Date() };
      if (arg('name')) patch.full_name = arg('name');
      if (password) patch.password_hash = await bcrypt.hash(password, 12);
      await knex('users').where('id', userId).update(patch);
      console.log(`Updated existing user ${email}`);
    } else {
      const name = arg('name');
      if (!name) throw new Error('--name is required when creating a user');
      const [row] = await knex('users')
        .insert({
          email,
          full_name: name,
          password_hash: await bcrypt.hash(password!, 12),
          user_type: 'INTERNAL',
          is_active: true,
        })
        .returning('id');
      userId = row.id;
      console.log(`Created user ${email}`);
    }

    for (const code of roles) {
      const role = await knex('roles').where('code', code).first();
      await knex('user_roles')
        .insert({ user_id: userId, role_id: role.id })
        .onConflict(['user_id', 'role_id'])
        .ignore();
      console.log(`  granted ${code}`);
    }

    const granted = await knex('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', userId)
      .pluck<string[]>('roles.code');
    console.log(`  roles now: ${granted.join(', ') || '(none)'}`);

    if (password && !arg('password')) {
      console.log(`\n  Password: ${password}\n`);
      console.log('  Shown once and not stored in clear. Deliver it out of band and');
      console.log('  have the holder change it after first sign-in.\n');
    }
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => {
  console.error(`\nFailed: ${(e as Error).message}\n`);
  process.exit(1);
});
