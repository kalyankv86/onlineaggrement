import { InvalidTransitionError, ForbiddenError } from '../common/errors/domain.errors';

/** SRS v1.1 §A8 — must stay in step with the `agreement_status` enum (migration 001). */
export const AGREEMENT_STATES = [
  'DRAFT',
  'READY_FOR_AGENT_SIGNATURE',
  'AGENT_SIGNING',
  'AGENT_SIGNED',
  'PENDING_EMPLOYEE_APPROVAL',
  'EMPLOYEE_APPROVING',
  'EMPLOYEE_APPROVED',
  'PENDING_MD_SIGNATURE',
  'MD_SIGNING',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'SIGNATURE_FAILED',
] as const;
export type AgreementState = (typeof AGREEMENT_STATES)[number];

export const WORKFLOW_ACTIONS = [
  'GENERATE',
  'AGENT_SIGN_INITIATE',
  'AGENT_SIGN_SUCCEED',
  'AGENT_SIGN_FAIL',
  'ADVANCE_TO_EMPLOYEE',
  'EMPLOYEE_REVIEW_START',
  'EMPLOYEE_APPROVE',
  'ADVANCE_TO_MD',
  'MD_SIGN_INITIATE',
  'MD_SIGN_SUCCEED',
  'MD_SIGN_FAIL',
  'RETRY_AGENT_SIGNATURE',
  'RETRY_MD_SIGNATURE',
  'REJECT',
  'CANCEL',
  'EXPIRE',
  'CORRECT',
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export type Role =
  | 'SUPER_ADMIN'
  | 'AGREEMENT_ADMIN'
  | 'AGENT'
  | 'EMPLOYEE'
  | 'MD'
  | 'MD_DELEGATE'
  | 'AUDITOR'
  | 'SYSTEM';

interface TransitionRule {
  from: AgreementState[];
  to: AgreementState;
  /** Roles permitted to trigger it. SYSTEM means only the engine itself. */
  roles: Role[];
  /** The requirement or business rule this edge implements. */
  rule: string;
  requiresReason?: boolean;
}

/**
 * The complete transition table. It is the *only* definition of what may happen
 * to an agreement — no service reads or writes `agreements.status` without going
 * through `assertTransition`.
 *
 * Sequencing (BR-002, BR-003) is expressed structurally rather than by a guard:
 * EMPLOYEE_APPROVE simply has no edge from any state before AGENT_SIGNED, and
 * MD_SIGN_INITIATE has none from any state before EMPLOYEE_APPROVED. There is no
 * ordering check to forget, and no flag that can be set out of order.
 */
export const TRANSITIONS: Record<WorkflowAction, TransitionRule> = {
  GENERATE: {
    from: ['DRAFT'],
    to: 'READY_FOR_AGENT_SIGNATURE',
    roles: ['AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN'],
    rule: 'FR-009',
  },

  // ── Agent signature (FR-011, BR-001) ────────────────────────────────────────
  AGENT_SIGN_INITIATE: {
    from: ['READY_FOR_AGENT_SIGNATURE'],
    to: 'AGENT_SIGNING',
    roles: ['AGENT'],
    rule: 'FR-011 / BR-001',
  },
  AGENT_SIGN_SUCCEED: {
    from: ['AGENT_SIGNING'],
    to: 'AGENT_SIGNED',
    roles: ['SYSTEM'],
    rule: 'FR-011',
  },
  AGENT_SIGN_FAIL: {
    from: ['AGENT_SIGNING'],
    to: 'SIGNATURE_FAILED',
    roles: ['SYSTEM'],
    rule: 'FR-011',
  },
  ADVANCE_TO_EMPLOYEE: {
    from: ['AGENT_SIGNED'],
    to: 'PENDING_EMPLOYEE_APPROVAL',
    roles: ['SYSTEM'],
    rule: 'FR-012',
  },

  // ── Employee approval (FR-012, BR-002) ──────────────────────────────────────
  // No edge exists from any pre-AGENT_SIGNED state: BR-002 is unreachable-by-design.
  EMPLOYEE_REVIEW_START: {
    from: ['PENDING_EMPLOYEE_APPROVAL'],
    to: 'EMPLOYEE_APPROVING',
    roles: ['EMPLOYEE'],
    rule: 'FR-012 / BR-002',
  },
  EMPLOYEE_APPROVE: {
    from: ['PENDING_EMPLOYEE_APPROVAL', 'EMPLOYEE_APPROVING'],
    to: 'EMPLOYEE_APPROVED',
    roles: ['EMPLOYEE'],
    rule: 'FR-012 / BR-002',
  },
  ADVANCE_TO_MD: {
    from: ['EMPLOYEE_APPROVED'],
    to: 'PENDING_MD_SIGNATURE',
    roles: ['SYSTEM'],
    rule: 'FR-013',
  },

  // ── MD signature (FR-013, BR-003, BR-007) ───────────────────────────────────
  MD_SIGN_INITIATE: {
    from: ['PENDING_MD_SIGNATURE'],
    to: 'MD_SIGNING',
    roles: ['MD', 'MD_DELEGATE'],
    rule: 'FR-013 / BR-003',
  },
  MD_SIGN_SUCCEED: {
    from: ['MD_SIGNING'],
    to: 'COMPLETED',
    roles: ['SYSTEM'],
    rule: 'FR-016 / BR-007',
  },
  MD_SIGN_FAIL: {
    from: ['MD_SIGNING'],
    to: 'SIGNATURE_FAILED',
    roles: ['SYSTEM'],
    rule: 'FR-013',
  },

  // ── Recovery ────────────────────────────────────────────────────────────────
  RETRY_AGENT_SIGNATURE: {
    from: ['SIGNATURE_FAILED'],
    to: 'READY_FOR_AGENT_SIGNATURE',
    roles: ['AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN'],
    rule: 'SRS v1.1 §A8',
  },
  RETRY_MD_SIGNATURE: {
    from: ['SIGNATURE_FAILED'],
    to: 'PENDING_MD_SIGNATURE',
    roles: ['MD', 'MD_DELEGATE', 'AGREEMENT_ADMIN', 'SUPER_ADMIN'],
    rule: 'SRS v1.1 §A8',
  },

  // ── Exceptions ──────────────────────────────────────────────────────────────
  REJECT: {
    from: ['PENDING_EMPLOYEE_APPROVAL', 'EMPLOYEE_APPROVING', 'PENDING_MD_SIGNATURE', 'MD_SIGNING'],
    to: 'REJECTED',
    roles: ['EMPLOYEE', 'MD', 'MD_DELEGATE'],
    rule: 'FR-015',
    requiresReason: true,
  },
  CANCEL: {
    from: [
      'DRAFT',
      'READY_FOR_AGENT_SIGNATURE',
      'AGENT_SIGNING',
      'AGENT_SIGNED',
      'PENDING_EMPLOYEE_APPROVAL',
      'EMPLOYEE_APPROVING',
      'EMPLOYEE_APPROVED',
      'PENDING_MD_SIGNATURE',
      'MD_SIGNING',
      'SIGNATURE_FAILED',
    ],
    to: 'CANCELLED',
    roles: ['AGREEMENT_ADMIN', 'SUPER_ADMIN'],
    rule: 'SRS v1.1 §A8',
    requiresReason: true,
  },
  EXPIRE: {
    from: [
      'READY_FOR_AGENT_SIGNATURE',
      'AGENT_SIGNING',
      'PENDING_EMPLOYEE_APPROVAL',
      'EMPLOYEE_APPROVING',
      'PENDING_MD_SIGNATURE',
      'MD_SIGNING',
      'SIGNATURE_FAILED',
    ],
    to: 'EXPIRED',
    roles: ['SYSTEM'],
    rule: 'FR-021',
  },
  CORRECT: {
    from: ['REJECTED', 'EXPIRED'],
    to: 'DRAFT',
    roles: ['AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN'],
    rule: 'FR-015a / BR-004',
  },
};

/** COMPLETED and CANCELLED are absolutely terminal (BR-005). */
export const ABSOLUTELY_TERMINAL: AgreementState[] = ['COMPLETED', 'CANCELLED'];

/** Terminal for the current version, but recoverable by correction (FR-015a). */
export const VERSION_TERMINAL: AgreementState[] = ['REJECTED', 'EXPIRED'];

export const isTerminal = (s: AgreementState): boolean =>
  ABSOLUTELY_TERMINAL.includes(s) || VERSION_TERMINAL.includes(s);

/** States where the workflow is waiting on a human, so the SLA clock runs (FR-021). */
export const PENDING_ACTION_STATES: AgreementState[] = [
  'READY_FOR_AGENT_SIGNATURE',
  'PENDING_EMPLOYEE_APPROVAL',
  'EMPLOYEE_APPROVING',
  'PENDING_MD_SIGNATURE',
];

export interface TransitionOutcome {
  from: AgreementState;
  to: AgreementState;
  action: WorkflowAction;
  rule: string;
}

/**
 * The single gate every state change passes through. Throws rather than returning
 * a boolean so that a caller cannot proceed by ignoring the result.
 */
export function assertTransition(
  from: AgreementState,
  action: WorkflowAction,
  actorRoles: Role[],
  opts: { reason?: string } = {},
): TransitionOutcome {
  const rule = TRANSITIONS[action];
  if (!rule) throw new InvalidTransitionError(from, action);

  if (!rule.from.includes(from)) {
    throw new InvalidTransitionError(from, rule.to, rule.rule);
  }

  const permitted = rule.roles.some((r) => actorRoles.includes(r));
  if (!permitted) {
    throw new ForbiddenError(
      `${actorRoles.filter((r) => r !== 'SYSTEM').join(', ') || 'actor'} may not perform ${action}`,
      rule.rule,
    );
  }

  if (rule.requiresReason && (!opts.reason || opts.reason.trim().length < 10)) {
    throw new ForbiddenError(
      `${action} requires a reason of at least 10 characters`,
      rule.rule,
    );
  }

  return { from, to: rule.to, action, rule: rule.rule };
}

/** Actions available to an actor right now — drives the UI without duplicating rules. */
export function availableActions(from: AgreementState, actorRoles: Role[]): WorkflowAction[] {
  return (Object.keys(TRANSITIONS) as WorkflowAction[]).filter((action) => {
    const rule = TRANSITIONS[action];
    return rule.from.includes(from) && rule.roles.some((r) => actorRoles.includes(r));
  });
}

/** Which signature widget, if any, a state is waiting on. */
export function pendingSigner(state: AgreementState): 'AGENT' | 'EMPLOYEE' | 'MD' | null {
  if (state === 'READY_FOR_AGENT_SIGNATURE' || state === 'AGENT_SIGNING') return 'AGENT';
  if (state === 'PENDING_EMPLOYEE_APPROVAL' || state === 'EMPLOYEE_APPROVING') return 'EMPLOYEE';
  if (state === 'PENDING_MD_SIGNATURE' || state === 'MD_SIGNING') return 'MD';
  return null;
}
