import { get } from '@/lib/api';
import { BankAdmin, type BankRow, type SignerOption } from '@/components/BankAdmin';

export const dynamic = 'force-dynamic';

export default async function BanksPage() {
  const [banks, signers] = await Promise.all([
    get<BankRow[]>('/api/v1/banks'),
    get<SignerOption[]>('/api/v1/banks/eligible-signers'),
  ]);

  const incomplete = banks.filter((b) => !b.has_active_document || !b.employee_signer_user_id);

  return (
    <>
      <h1>Banks</h1>
      <p className="page-sub">
        Each bank has its own agreement text and its own GTIDS countersigner. Agents execute their
        own bank&apos;s agreement and cannot substitute another document.
      </p>

      {incomplete.length > 0 && (
        <div className="notice notice-warn">
          <strong>
            {incomplete.length === 1
              ? '1 bank is not ready for use'
              : `${incomplete.length} banks are not ready for use`}
          </strong>
          <p style={{ margin: '6px 0 0' }}>
            {incomplete.map((b) => b.name).join(', ')} —{' '}
            {incomplete.length === 1 ? 'it needs' : 'each needs'} a countersigner and an active
            agreement document. An agent at an unfinished bank cannot create an agreement, and will
            be told which is missing.
          </p>
        </div>
      )}

      <BankAdmin banks={banks} signers={signers} />
    </>
  );
}
