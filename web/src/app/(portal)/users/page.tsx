import { get } from '@/lib/api';
import { UserAdmin, type UserRow, type BankOption } from '@/components/UserAdmin';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const [users, banks] = await Promise.all([
    get<UserRow[]>('/api/v1/users'),
    get<BankOption[]>('/api/v1/banks'),
  ]);

  const agentsWithoutBank = users.filter(
    (u) => u.is_active && u.roles.includes('AGENT') && !u.bank_id,
  );

  return (
    <>
      <h1>Users</h1>
      <p className="page-sub">
        GTIDS staff and the agents who act for each bank. An agent belongs to one bank, which
        decides the agreement they execute; GTIDS staff belong to none.
      </p>

      {agentsWithoutBank.length > 0 && (
        <div className="notice notice-warn">
          <strong>
            {agentsWithoutBank.length === 1
              ? '1 agent has no bank'
              : `${agentsWithoutBank.length} agents have no bank`}
          </strong>
          <p style={{ margin: '6px 0 0' }}>
            {agentsWithoutBank.map((u) => u.full_name).join(', ')} — they cannot create an agreement
            until a bank is set, because there is no agreement text to compose from.
          </p>
        </div>
      )}

      <UserAdmin users={users} banks={banks} />
    </>
  );
}
