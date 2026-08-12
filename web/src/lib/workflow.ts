import type { AgreementStatus } from './api';

/**
 * Presentation-only view of the workflow.
 *
 * Deliberately does NOT decide what a user may do — `availableActions` on the
 * agreement comes from the API's transition table, so the UI never re-implements
 * (and never drifts from) the rules in state-machine.ts.
 */

export const STATUS_LABEL: Record<AgreementStatus, string> = {
  DRAFT: 'Draft',
  READY_FOR_AGENT_SIGNATURE: 'Awaiting agent signature',
  AGENT_SIGNING: 'Agent signing in progress',
  AGENT_SIGNED: 'Agent signed',
  // Retained for agreements executed before DEC-024 changed the workflow.
  PENDING_EMPLOYEE_APPROVAL: 'Awaiting employee approval (legacy)',
  EMPLOYEE_APPROVING: 'Employee reviewing (legacy)',
  EMPLOYEE_APPROVED: 'Employee approved (legacy)',
  PENDING_MD_SIGNATURE: 'Awaiting MD signature',
  MD_SIGNING: 'MD signing in progress',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  SIGNATURE_FAILED: 'Signature failed',
};

export type StatusTone = 'neutral' | 'progress' | 'waiting' | 'success' | 'danger';

export const STATUS_TONE: Record<AgreementStatus, StatusTone> = {
  DRAFT: 'neutral',
  READY_FOR_AGENT_SIGNATURE: 'waiting',
  AGENT_SIGNING: 'progress',
  AGENT_SIGNED: 'progress',
  PENDING_EMPLOYEE_APPROVAL: 'waiting',
  EMPLOYEE_APPROVING: 'progress',
  EMPLOYEE_APPROVED: 'progress',
  PENDING_MD_SIGNATURE: 'waiting',
  MD_SIGNING: 'progress',
  COMPLETED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'danger',
  EXPIRED: 'danger',
  SIGNATURE_FAILED: 'danger',
};

/**
 * The mandated milestones (DEC-024). Two, not three — the Employee approval step
 * was removed. Document preparation is shown as a step of its own because with
 * uploaded agreements it is real work someone has to do, not an instant.
 */
export const MILESTONES = [
  { key: 'PREPARED', label: 'Stamp & agreement attached' },
  { key: 'AGENT', label: 'Agent signs' },
  { key: 'MD', label: 'MD signs' },
] as const;

export type MilestoneState = 'done' | 'active' | 'pending' | 'stopped';

export function milestoneStates(status: AgreementStatus): MilestoneState[] {
  const order: AgreementStatus[] = [
    'DRAFT',
    'READY_FOR_AGENT_SIGNATURE',
    'AGENT_SIGNING',
    'AGENT_SIGNED',
    'PENDING_MD_SIGNATURE',
    'MD_SIGNING',
    'COMPLETED',
  ];

  if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(status)) {
    return ['stopped', 'stopped', 'stopped'];
  }

  const i = order.indexOf(status);
  return [
    i > order.indexOf('DRAFT') ? 'done' : 'active',
    i >= order.indexOf('AGENT_SIGNED')
      ? 'done'
      : i >= order.indexOf('READY_FOR_AGENT_SIGNATURE')
        ? 'active'
        : 'pending',
    status === 'COMPLETED'
      ? 'done'
      : i >= order.indexOf('PENDING_MD_SIGNATURE')
        ? 'active'
        : 'pending',
  ];
}

/** Human labels for audit event types (SRS §10). */
export const AUDIT_LABEL: Record<string, string> = {
  AGREEMENT_CREATED: 'Agreement created',
  AGREEMENT_CORRECTED: 'Agreement corrected',
  STAMP_UPLOADED: 'Stamp paper registered',
  STAMP_ALLOCATED: 'Stamp allocated',
  STAMP_RELEASED: 'Stamp released',
  STAMP_MARKED_USED: 'Stamp marked used',
  AGREEMENT_GENERATED: 'Stamp and agreement composed',
  DOCUMENT_VIEWED: 'Document viewed',
  AGENT_SIGN_INITIATED: 'Agent signing started',
  AGENT_SIGNED: 'Agent signed',
  EMPLOYEE_APPROVED: 'Employee approved',
  EMPLOYEE_REJECTED: 'Employee rejected',
  MD_SIGN_INITIATED: 'MD signing started',
  MD_SIGNED: 'MD signed',
  MD_REJECTED: 'MD rejected',
  AGREEMENT_COMPLETED: 'Agreement completed',
  AGREEMENT_CANCELLED: 'Agreement cancelled',
  AGREEMENT_EXPIRED: 'Agreement expired',
  FINAL_DOCUMENT_GENERATED: 'Final document produced',
  EMAIL_SENT: 'Email sent',
  EMAIL_FAILED: 'Email failed',
  DOCUMENT_DOWNLOADED: 'Document downloaded',
  DOCUMENT_VERIFIED: 'Publicly verified',
  SIGNATURE_FAILED: 'Signature failed',
  SIGNATURE_INTEGRITY_ALERT: 'Signature integrity alert',
  PARTY_ACCESS_ISSUED: 'Access link issued',
  PARTY_ACCESS_REDEEMED: 'Access link redeemed',
  LOGIN_SUCCEEDED: 'Signed in',
  LOGIN_FAILED: 'Sign-in failed',
  AUDIT_CHAIN_BROKEN: 'AUDIT CHAIN BROKEN',
};

export const formatDate = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      })
    : '—';

export const formatDateOnly = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' })
    : '—';

export const shortHash = (hash: string | null | undefined): string =>
  hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : '—';
