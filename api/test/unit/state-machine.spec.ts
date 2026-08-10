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

  describe('BR-002 — employee approval is unreachable before the agent signature', () => {
    const beforeAgentSigned: AgreementState[] = [
      'DRAFT',
      'READY_FOR_AGENT_SIGNATURE',
      'AGENT_SIGNING',
    ];

    it.each(beforeAgentSigned)('cannot approve from %s', (state) => {
      expectRefusal(
        () => assertTransition(state, 'EMPLOYEE_APPROVE', ['EMPLOYEE']),
        InvalidTransitionError,
      );
    });

    it('can approve once the agreement is pending employee approval', () => {
      const outcome = assertTransition('PENDING_EMPLOYEE_APPROVAL', 'EMPLOYEE_APPROVE', ['EMPLOYEE']);
      expect(outcome.to).toBe('EMPLOYEE_APPROVED');
    });

    it('is structural, not a guard — no edge exists at all', () => {
      // The property that matters: there is no state before AGENT_SIGNED from
      // which EMPLOYEE_APPROVE is defined, so there is no ordering check to forget.
      for (const from of TRANSITIONS.EMPLOYEE_APPROVE.from) {
        expect(beforeAgentSigned).not.toContain(from);
      }
    });
  });

  describe('BR-003 — MD signing is unreachable before employee approval', () => {
    const beforeApproval: AgreementState[] = [
      'DRAFT',
      'READY_FOR_AGENT_SIGNATURE',
      'AGENT_SIGNING',
      'AGENT_SIGNED',
      'PENDING_EMPLOYEE_APPROVAL',
      'EMPLOYEE_APPROVING',
    ];

    it.each(beforeApproval)('MD cannot start signing from %s', (state) => {
      expectRefusal(() => assertTransition(state, 'MD_SIGN_INITIATE', ['MD']), InvalidTransitionError);
    });

    it('MD can sign once employee approval has advanced the agreement', () => {
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
    it('an employee cannot sign as the agent', () => {
      expectRefusal(
        () => assertTransition('READY_FOR_AGENT_SIGNATURE', 'AGENT_SIGN_INITIATE', ['EMPLOYEE']),
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
        ['PENDING_EMPLOYEE_APPROVAL', 'EMPLOYEE_APPROVE', ['EMPLOYEE']],
        ['EMPLOYEE_APPROVED', 'ADVANCE_TO_MD', ['SYSTEM']],
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
      expect(pendingSigner('PENDING_EMPLOYEE_APPROVAL')).toBe('EMPLOYEE');
      expect(pendingSigner('PENDING_MD_SIGNATURE')).toBe('MD');
      expect(pendingSigner('COMPLETED')).toBeNull();
    });
  });
});
