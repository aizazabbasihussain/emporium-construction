import { describe, expect, it } from 'vitest';
import type { Actor } from '../types.js';
import {
  assertInScope,
  assertMayRead,
  isInboxVisible,
  isInScope,
  scopeOf,
} from './approvals.policy.js';

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 'u1',
  roles: ['project_manager'],
  scopes: [],
  requestId: null,
  ...over,
});
const supervisor = actor({
  roles: ['supervisor'],
  scopes: [{ type: 'project', id: 'p1' }],
});

describe('scopeOf', () => {
  it('reads a well-formed scope and ignores anything else', () => {
    expect(scopeOf({ scope: { type: 'project', id: 'p1' } })).toEqual({
      type: 'project',
      id: 'p1',
    });
    expect(scopeOf({ scope: { type: 'team', id: 't1' } })).toEqual({ type: 'team', id: 't1' });
    expect(scopeOf({})).toBeNull();
    expect(scopeOf({ scope: { type: 'office', id: 'x' } })).toBeNull();
    expect(scopeOf({ scope: { type: 'project', id: 7 } })).toBeNull();
  });
});

describe('scope (BR-7)', () => {
  it('lets unscoped roles see everything and limits scoped roles to their projects', () => {
    const inScope = { scope: { type: 'project', id: 'p1' } };
    const outScope = { scope: { type: 'project', id: 'p2' } };
    expect(isInScope(actor(), outScope)).toBe(true);
    expect(isInScope(supervisor, inScope)).toBe(true);
    expect(isInScope(supervisor, outScope)).toBe(false);
    expect(isInScope(supervisor, {})).toBe(true);
    expect(() => assertInScope(supervisor, inScope)).not.toThrow();
    expect(() => assertInScope(supervisor, outScope)).toThrowError(
      expect.objectContaining({ kind: 'not_found' }),
    );
  });
});

describe('inbox visibility (BR-7)', () => {
  const request = { requesterId: 'other', currentRole: 'project_manager', context: {} };

  it('shows requests whose current step role the user holds', () => {
    expect(isInboxVisible(actor(), request)).toBe(true);
    expect(isInboxVisible(actor({ roles: ['accountant'] }), request)).toBe(false);
  });

  it('hides own requests, finished requests and out-of-scope documents', () => {
    expect(isInboxVisible(actor({ userId: 'other' }), request)).toBe(false);
    expect(isInboxVisible(actor(), { ...request, currentRole: null })).toBe(false);
    expect(
      isInboxVisible(
        { ...supervisor, roles: ['supervisor'] },
        {
          ...request,
          currentRole: 'supervisor',
          context: { scope: { type: 'project', id: 'p2' } },
        },
      ),
    ).toBe(false);
  });
});

describe('request read access', () => {
  const request = { requesterId: 'owner', stepRoles: ['management'], context: {} };

  it('allows the requester, rule managers and approvers of the rule', () => {
    expect(() => assertMayRead(actor({ userId: 'owner' }), request, false)).not.toThrow();
    expect(() => assertMayRead(actor(), request, true)).not.toThrow();
    expect(() => assertMayRead(actor({ roles: ['management'] }), request, false)).not.toThrow();
  });

  it('reports everyone else, and approvers outside their scope, as not found', () => {
    expect(() => assertMayRead(actor(), request, false)).toThrowError(
      expect.objectContaining({ kind: 'not_found' }),
    );
    expect(() =>
      assertMayRead(
        supervisor,
        {
          requesterId: 'owner',
          stepRoles: ['supervisor'],
          context: { scope: { type: 'project', id: 'p2' } },
        },
        false,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'not_found' }));
  });
});
