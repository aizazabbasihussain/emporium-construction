import { describe, expect, it } from 'vitest';
import { assertMayForce, assertOwnDryRun } from './importer.policy.js';

describe('importer policy', () => {
  it('lets anyone commit without force, and only force holders force (BR-4)', () => {
    expect(() => assertMayForce(new Set(), false)).not.toThrow();
    expect(() => assertMayForce(new Set(['importer.batch.force']), true)).not.toThrow();
    expect(() => assertMayForce(new Set(['importer.batch.run']), true)).toThrow(
      /Missing permission importer.batch.force/,
    );
    expect(() => assertMayForce(new Set(), true)).toThrowError(
      expect.objectContaining({ kind: 'forbidden', code: 'permission_denied' }),
    );
  });

  it('requires the committer to be the user who ran the dry run (BR-2)', () => {
    expect(() => assertOwnDryRun('u1', 'u1')).not.toThrow();
    expect(() => assertOwnDryRun('u1', 'u2')).toThrowError(
      expect.objectContaining({ kind: 'forbidden', code: 'dry_run_by_other_user' }),
    );
    expect(() => assertOwnDryRun(null, 'u2')).toThrow(/Only the user/);
  });
});
