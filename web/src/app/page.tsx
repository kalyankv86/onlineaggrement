import { redirect } from 'next/navigation';
import { currentPrincipal } from '@/lib/session';

export default async function RootPage() {
  const principal = await currentPrincipal();
  redirect(
    principal
      ? principal.scopedAgreementId
        ? `/agreements/${principal.scopedAgreementId}`
        : '/agreements'
      : '/login',
  );
}
