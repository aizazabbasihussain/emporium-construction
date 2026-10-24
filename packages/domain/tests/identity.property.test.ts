import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unionPermissions } from '../src/identity/permissions.js';

const code = fc.constantFrom(
  'a.b.read',
  'a.b.write',
  'c.d.read',
  'c.d.manage',
  'e.f.approve',
  'g.h.read',
);
const role = fc.record({
  code: fc.string({ minLength: 1, maxLength: 8 }),
  permissions: fc.array(code, { maxLength: 6 }),
});

describe('permission union (property tests, T-6)', () => {
  it('property: the union equals the set of every permission of every role', () => {
    fc.assert(
      fc.property(fc.array(role, { maxLength: 6 }), (roles) => {
        const union = unionPermissions(roles);
        const expected = new Set(roles.flatMap((r) => r.permissions));
        expect(union).toEqual(expected);
        for (const r of roles) for (const p of r.permissions) expect(union.has(p)).toBe(true);
      }),
    );
  });

  it('property: order and duplicate roles do not change the union', () => {
    fc.assert(
      fc.property(fc.array(role, { maxLength: 6 }), (roles) => {
        const reversed = [...roles].reverse();
        expect(unionPermissions(reversed)).toEqual(unionPermissions(roles));
        expect(unionPermissions([...roles, ...roles])).toEqual(unionPermissions(roles));
      }),
    );
  });
});
