import { describe, expect, it } from 'vitest';
import { lastDecision } from './support.js';

const pending = (actions: { actorId: string; comment: string | null }[]) =>
  ({ status: 'approved', actions }) as never;

describe('lastDecision (BR-8)', () => {
  it('reports nobody for a document that was never submitted', () => {
    expect(lastDecision({ status: 'none', docType: 'attendance_sheet', docId: 'x' })).toEqual({
      actorId: null,
      comment: null,
    });
  });

  it('returns the actor and comment of the latest action', () => {
    expect(
      lastDecision(
        pending([
          { actorId: 'a', comment: 'first' },
          { actorId: 'b', comment: 'Check the second worker' },
        ]),
      ),
    ).toEqual({ actorId: 'b', comment: 'Check the second worker' });
    expect(lastDecision(pending([{ actorId: 'c', comment: null }]))).toEqual({
      actorId: 'c',
      comment: null,
    });
  });

  it('copes with a request that has no actions yet', () => {
    expect(lastDecision(pending([]))).toEqual({ actorId: null, comment: null });
  });
});
