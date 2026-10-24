import {
  AGREEMENT_STATES,
  TRANSITIONS,
  WORKFLOW_ACTIONS,
  assertTransition,
  availableActions,
  isTerminal,
  pendingSigner,
  AgreementState,
  Role,
} from '../../src/workflow/state-machine';
import { InvalidTransitionError, ForbiddenError } from '../../src/common/errors/domain.errors';

const expectRefusal = (fn: () => unknown, type: unknown = Error) => {
  expect(fn).toThrow(type as never);
};

describe('agreement state machine', () => {
  describe('table integrity', () => {
    it('every action targets a declared state and starts from declared states', () => {
      for (const action of WORKFLOW_ACTIONS) {
        const rule = TRANSITIONS[action];
        expect(AGREEMENT_STATES).toContain(rule.to);
        for (const from of rule.from) expect(AGREEMENT_STATES).toContain(from);
        expect(rule.roles.length).toBeGreaterThan(0);
        expect(rule.rule).toBeTruthy();
      }
    });

    it('every non-terminal state has at least one way out', () => {
      const terminal: AgreementState[] = ['COMPLETED', 'CANCELLED'];
      for (const state of AGREEMENT_STATES) {
        if (terminal.includes(state)) continue;
        const exits = WORKFLOW_ACTIONS.filter((a) => TRANSITIONS[a].from.includes(state));
        expect(exits.length).toBeGreaterThan(0);
      }
    });

    it('COMPLETED and CANCELLED are absolutely terminal (BR-005)', () => {
      for (const action of WORKFLOW_ACTIONS) {
        expect(TRANSITIONS[action].from).not.toContain('COMPLETED');
        expect(TRANSITIONS[action].from).not.toContain('CANCELLED');
      }
      expect(isTerminal('COMPLETED')).toBe(true);
      expect(isTerminal('CANCELLED')).toBe(true);
    });
  });

  describe('DEC-033 — the employee signs, and the approval states stay dead', () => {
    it('leaves DEC-004\'s attested-approval states unreachable', () => {
      // DEC-033 restored the step as a *signature*. The approval states remain in
      // the enum so agreements executed under DEC-004 stay readable, but nothing
      // may reach them again — otherwise a signature could be recorded under a
      // state name that says someone merely clicked approve.
      const approvalStates: AgreementState[] = [
        'PENDING_EMPLOYEE_APPROVAL',
        'EMPLOYEE_APPROVING',
        'EMPLOYEE_APPROVED',
      ];
      for (const action of WORKFLOW_ACTIONS) {
        expect(approvalStates).not.toContain(TRANSITIONS[action].to);
      }
    });

    it('routes the agent signature to the employee, not to the MD', () => {
      expect(TRANSITIONS.ADVANCE_TO_EMPLOYEE.from).toEqual(['AGENT_SIGNED']);
      expect(TRANSITIONS.ADVANCE_TO_EMPLOYEE.to).toBe('PENDING_EMPLOYEE_SIGNATURE');
      expect(TRANSITIONS.ADVANCE_TO_MD.from).toEqual(['EMPLOYEE_SIGNED']);
    });

    it('makes each waiting state reachable by exactly one edge (BR-002, BR-003)', () => {
      // This is what enforces the order. Not a guard that could be forgotten: a
      // second inbound edge would be a way to skip a signer, so the count matters.
      for (const waiting of [
        'PENDING_EMPLOYEE_SIGNATURE',
        'PENDING_MD_SIGNATURE',
      ] as AgreementState[]) {
        const inbound = WORKFLOW_ACTIONS.filter((a) => TRANSITIONS[a].to === waiting);
        // RETRY_* edges come from SIGNATURE_FAILED, which is recovery, not a skip.
        const forward = inbound.filter((a) => !a.startsWith('RETRY_'));
        expect(forward).toHaveLength(1);
      }
    });

    it('refuses an employee signature before the agent has signed', () => {
      for (const before of [
        'DRAFT',
        'READY_FOR_AGENT_SIGNATURE',
        'AGENT_SIGNING',
      ] as AgreementState[]) {
        expect(() =>
          assertTransition(before, 'EMPLOYEE_SIGN_INITIATE', ['EMPLOYEE']),
        ).toThrow();
      }
    });

    it('refuses an MD signature before the employee has signed', () => {
      for (const before of ['AGENT_SIGNED', 'PENDING_EMPLOYEE_SIGNATURE'] as AgreementState[]) {
        expect(() => assertTransition(before, 'MD_SIGN_INITIATE', ['MD'])).toThrow();
      }
    });

    it('gives the employee an action only where one is due', () => {
      const withAction = AGREEMENT_STATES.filter(
        (state) => availableActions(state, ['EMPLOYEE']).length > 0,
      );
      // Only where the agreement is actually waiting on them, plus recovery.
      // Notably NOT the MD's states: having signed, rejecting is no longer theirs.
      expect(withAction.sort()).toEqual(
        ['EMPLOYEE_SIGNING', 'PENDING_EMPLOYEE_SIGNATURE', 'SIGNATURE_FAILED'].sort(),
      );
    });
  });

  describe('BR-003 — MD signing is unreachable before the earlier parties sign', () => {
    const beforeAgentSigned: AgreementState[] = [
      'DRAFT',
      'READY_FOR_AGENT_SIGNATURE',
      'AGENT_SIGNING',
      // DEC-033 — and now also before the employee has signed.
      'AGENT_SIGNED',
      'PENDING_EMPLOYEE_SIGNATURE',
      'EMPLOYEE_SIGNING',
    ];

    it.each(beforeAgentSigned)('MD cannot start signing from %s', (state) => {
      expectRefusal(() => assertTransition(state, 'MD_SIGN_INITIATE', ['MD']), InvalidTransitionError);
    });

    it('PENDING_MD_SIGNATURE has exactly one inbound edge, from EMPLOYEE_SIGNED', () => {
      const inbound = WORKFLOW_ACTIONS.filter(
        (a) => TRANSITIONS[a].to === 'PENDING_MD_SIGNATURE' && a !== 'RETRY_MD_SIGNATURE',
      );
      expect(inbound).toEqual(['ADVANCE_TO_MD']);
      expect(TRANSITIONS.ADVANCE_TO_MD.from).toEqual(['EMPLOYEE_SIGNED']);
    });

    it('MD can sign once the employee signature has advanced the agreement', () => {
      expect(assertTransition('PENDING_MD_SIGNATURE', 'MD_SIGN_INITIATE', ['MD']).to).toBe(
        'MD_SIGNING',
      );
    });
  });

  describe('AC-04 — MD cannot sign a rejected, expired or cancelled agreement', () => {
    it.each<AgreementState>(['REJECTED', 'EXPIRED', 'CANCELLED'])(
      'refuses MD signature from %s',
      (state) => {
        expectRefusal(
          () => assertTransition(state, 'MD_SIGN_INITIATE', ['MD']),
          InvalidTransitionError,
        );
      },
    );
  });

  describe('BR-007 — completion only follows a successful MD signature', () => {
    it('COMPLETED has exactly one inbound edge, from MD_SIGNING', () => {
      const inbound = WORKFLOW_ACTIONS.filter((a) => TRANSITIONS[a].to === 'COMPLETED');
      expect(inbound).toEqual(['MD_SIGN_SUCCEED']);
      expect(TRANSITIONS.MD_SIGN_SUCCEED.from).toEqual(['MD_SIGNING']);
    });

    it('only the system may declare completion, never a user', () => {
      expect(TRANSITIONS.MD_SIGN_SUCCEED.roles).toEqual(['SYSTEM']);
      expectRefusal(() => assertTransition('MD_SIGNING', 'MD_SIGN_SUCCEED', ['MD']), ForbiddenError);
    });
  });

  describe('BR-001 — role authority', () => {
    it('an MD cannot sign as the agent', () => {
      expectRefusal(
        () => assertTransition('READY_FOR_AGENT_SIGNATURE', 'AGENT_SIGN_INITIATE', ['MD']),
        ForbiddenError,
      );
    });

    it('an auditor can do nothing but read', () => {
      for (const state of AGREEMENT_STATES) {
        expect(availableActions(state, ['AUDITOR'])).toEqual([]);
      }
    });

    it('an MD delegate may sign in the MD’s place (DEC-014)', () => {
      expect(assertTransition('PENDING_MD_SIGNATURE', 'MD_SIGN_INITIATE', ['MD_DELEGATE']).to).toBe(
        'MD_SIGNING',
      );
    });
  });

  describe('FR-015 — rejection requires a substantive reason', () => {
    it('refuses an empty reason', () => {
      expectRefusal(
        () => assertTransition('PENDING_MD_SIGNATURE', 'REJECT', ['MD']),
        ForbiddenError,
      );
    });

    it('refuses a token reason', () => {
      expectRefusal(
        () => assertTransition('PENDING_MD_SIGNATURE', 'REJECT', ['MD'], { reason: 'no' }),
        ForbiddenError,
      );
    });

    it('accepts a reason of at least 10 characters', () => {
      const outcome = assertTransition('PENDING_MD_SIGNATURE', 'REJECT', ['MD'], {
        reason: 'Consideration clause is incorrect',
      });
      expect(outcome.to).toBe('REJECTED');
    });

    it('cancellation also requires a reason', () => {
      expectRefusal(
        () => assertTransition('DRAFT', 'CANCEL', ['SUPER_ADMIN'], { reason: 'x' }),
        ForbiddenError,
      );
    });
  });

  describe('BR-004 / FR-015a — correction path', () => {
    it('a rejected or expired agreement returns to DRAFT for version N+1', () => {
      expect(assertTransition('REJECTED', 'CORRECT', ['AGENT']).to).toBe('DRAFT');
      expect(assertTransition('EXPIRED', 'CORRECT', ['AGENT']).to).toBe('DRAFT');
    });

    it('a completed agreement can never be corrected', () => {
      expectRefusal(() => assertTransition('COMPLETED', 'CORRECT', ['AGENT']), InvalidTransitionError);
    });
  });

  describe('FR-021 — expiry', () => {
    it('only the system expires agreements', () => {
      expect(TRANSITIONS.EXPIRE.roles).toEqual(['SYSTEM']);
    });

    it('a completed agreement cannot expire', () => {
      expectRefusal(() => assertTransition('COMPLETED', 'EXPIRE', ['SYSTEM']), InvalidTransitionError);
    });
  });

  describe('the happy path end to end', () => {
    it('walks DRAFT to COMPLETED with no skipped state', () => {
      const path: [AgreementState, Parameters<typeof assertTransition>[1], Role[]][] = [
        ['DRAFT', 'GENERATE', ['AGENT']],
        ['READY_FOR_AGENT_SIGNATURE', 'AGENT_SIGN_INITIATE', ['AGENT']],
        ['AGENT_SIGNING', 'AGENT_SIGN_SUCCEED', ['SYSTEM']],
        ['AGENT_SIGNED', 'ADVANCE_TO_EMPLOYEE', ['SYSTEM']],
        ['PENDING_EMPLOYEE_SIGNATURE', 'EMPLOYEE_SIGN_INITIATE', ['EMPLOYEE']],
        ['EMPLOYEE_SIGNING', 'EMPLOYEE_SIGN_SUCCEED', ['SYSTEM']],
        ['EMPLOYEE_SIGNED', 'ADVANCE_TO_MD', ['SYSTEM']],
        ['PENDING_MD_SIGNATURE', 'MD_SIGN_INITIATE', ['MD']],
        ['MD_SIGNING', 'MD_SIGN_SUCCEED', ['SYSTEM']],
      ];

      let state: AgreementState = 'DRAFT';
      for (const [expectedFrom, action, roles] of path) {
        expect(state).toBe(expectedFrom);
        state = assertTransition(state, action, roles).to;
      }
      expect(state).toBe('COMPLETED');
    });
  });

  describe('pendingSigner', () => {
    it('names who each waiting state is waiting on', () => {
      expect(pendingSigner('READY_FOR_AGENT_SIGNATURE')).toBe('AGENT');
      expect(pendingSigner('PENDING_MD_SIGNATURE')).toBe('MD');
      expect(pendingSigner('COMPLETED')).toBeNull();
    });
  });
});
