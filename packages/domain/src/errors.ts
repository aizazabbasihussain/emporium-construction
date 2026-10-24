export type ErrorKind =
  'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rule_violation';

export class DomainError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly details: unknown;

  constructor(kind: ErrorKind, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, details?: unknown) {
    super('validation', code, message, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(code = 'unauthorized', message = 'Authentication required') {
    super('unauthorized', code, message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(code = 'forbidden', message = 'Not allowed') {
    super('forbidden', code, message);
  }
}

export class NotFoundError extends DomainError {
  constructor(code = 'not_found', message = 'Not found') {
    super('not_found', code, message);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: unknown) {
    super('conflict', code, message, details);
  }
}

export class RuleViolationError extends DomainError {
  constructor(code: string, message: string, details?: unknown) {
    super('rule_violation', code, message, details);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
