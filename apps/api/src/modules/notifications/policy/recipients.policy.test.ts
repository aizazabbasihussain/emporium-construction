import { describe, expect, it } from 'vitest';
import type { DirectoryUser } from '../types.js';
import { approverIds, scopeOf } from './recipients.policy.js';

const pm: DirectoryUser = { id: 'pm', roles: ['project_manager'], scopes: [] };
const requester: DirectoryUser = { id: 'req', roles: ['project_manager'], scopes: [] };
const inScope: DirectoryUser = {
  id: 'sup1',
  roles: ['supervisor'],
  scopes: [{ type: 'project', id: 'p1' }],
};
const outOfScope: DirectoryUser = {
  id: 'sup2',
  roles: ['supervisor'],
  scopes: [{ type: 'project', id: 'p2' }],
};

describe('scopeOf', () => {
  it('reads a well formed project or team scope', () => {
    expect(scopeOf({ scope: { type: 'project', id: 'p1' } })).toEqual({
      type: 'project',
      id: 'p1',
    });
    expect(scopeOf({ scope: { type: 'team', id: 't1' } })).toEqual({ type: 'team', id: 't1' });
  });

  it.each([
    undefined,
    {},
    { scope: 'p1' },
    { scope: { type: 'site', id: 'p1' } },
    { scope: { type: 'project', id: 7 } },
  ])('ignores %j', (context) => {
    expect(scopeOf(context as Record<string, unknown> | undefined)).toBeNull();
  });
});

describe('approverIds (BR-10)', () => {
  it('never includes the requester', () => {
    expect(approverIds([pm, requester], { requesterId: 'req' })).toEqual(['pm']);
  });

  it('keeps everyone when the request has no scope', () => {
    expect(approverIds([inScope, outOfScope], { requesterId: 'x', context: {} })).toEqual([
      'sup1',
      'sup2',
    ]);
  });

  it('keeps only holders who may see the scope of the request', () => {
    const request = { requesterId: 'x', context: { scope: { type: 'project', id: 'p1' } } };
    expect(approverIds([inScope, outOfScope, pm], request)).toEqual(['sup1', 'pm']);
  });

  it('returns nobody when nobody holds the role', () => {
    expect(approverIds([], { requesterId: 'x' })).toEqual([]);
  });
});
