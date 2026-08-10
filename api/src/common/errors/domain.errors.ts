/**
 * Domain errors carry a stable machine-readable code and the rule they enforce,
 * so an API consumer can branch on the code and an auditor can trace a refusal
 * back to a numbered requirement.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 400,
    readonly rule?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id?: string) {
    super('NOT_FOUND', id ? `${what} ${id} not found` : `${what} not found`, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string, rule?: string) {
    super('FORBIDDEN', message, 403, rule);
  }
}

/** A transition the state machine does not permit (SRS v1.1 §A8 rule 1). */
export class InvalidTransitionError extends DomainError {
  constructor(from: string, to: string, rule = 'FR-014') {
    super(
      'INVALID_TRANSITION',
      `Cannot move agreement from ${from} to ${to}`,
      409,
      rule,
      { from, to },
    );
  }
}

/** Lost a race — the caller should re-read and retry. */
export class ConflictError extends DomainError {
  constructor(message: string, rule?: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, 409, rule, details);
  }
}

/** FR-027 — the actor acted on a document that is no longer current. */
export class StaleDocumentError extends DomainError {
  constructor(expected: string, actual: string) {
    super(
      'STALE_DOCUMENT',
      'The document changed since it was presented; re-read it and act again',
      409,
      'FR-027',
      { presentedHash: expected, currentHash: actual },
    );
  }
}

/** SRS v1.1 §8.3 — a prior signature stopped verifying. Always a security event. */
export class SignatureIntegrityError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('SIGNATURE_INTEGRITY', message, 500, 'SRS-8.3', details);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, 422, undefined, details);
  }
}
