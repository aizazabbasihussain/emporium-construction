import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RuleViolationError,
  UnauthorizedError,
  ValidationError,
  isDomainError,
} from './errors.js';

describe('domain error model', () => {
  it('carries kind, code, message and details', () => {
    const e = new ValidationError('bad_input', 'Bad input', { field: 'name' });
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('validation');
    expect(e.code).toBe('bad_input');
    expect(e.message).toBe('Bad input');
    expect(e.details).toEqual({ field: 'name' });
    expect(e.name).toBe('ValidationError');
  });

  it('maps each class to its kind and defaults', () => {
    expect(new UnauthorizedError()).toMatchObject({
      kind: 'unauthorized',
      code: 'unauthorized',
      message: 'Authentication required',
    });
    expect(new ForbiddenError()).toMatchObject({ kind: 'forbidden', code: 'forbidden' });
    expect(new NotFoundError()).toMatchObject({ kind: 'not_found', code: 'not_found' });
    expect(new ConflictError('stale', 'Version mismatch')).toMatchObject({ kind: 'conflict' });
    expect(new RuleViolationError('rule', 'Rule broken')).toMatchObject({
      kind: 'rule_violation',
    });
  });

  it('accepts custom codes and messages', () => {
    expect(new UnauthorizedError('expired', 'Token expired')).toMatchObject({
      code: 'expired',
      message: 'Token expired',
    });
    expect(new ForbiddenError('no_scope', 'No scope')).toMatchObject({ code: 'no_scope' });
    expect(new NotFoundError('no_project', 'No such project')).toMatchObject({
      code: 'no_project',
    });
  });

  it('recognises domain errors', () => {
    expect(isDomainError(new NotFoundError())).toBe(true);
    expect(isDomainError(new Error('x'))).toBe(false);
    expect(isDomainError('x')).toBe(false);
  });
});
