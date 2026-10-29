import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkTaskUpdate, isPastDeadline, selectMissing } from '../src/dpr/index.js';

describe('daily progress report invariants', () => {
  it('a task percent that does not fall always passes, and a fall passes only with a note', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (now, next) => {
          const withoutNote = () => checkTaskUpdate({ taskId: 't', percentComplete: next }, now);
          if (next >= now) expect(withoutNote().percentComplete).toBe(next);
          else expect(withoutNote).toThrow();
          expect(
            checkTaskUpdate({ taskId: 't', percentComplete: next, note: 'why' }, now)
              .percentComplete,
          ).toBe(next);
        },
      ),
      { seed: 15 },
    );
  });

  it('missing projects are exactly the supervised ones that did not file', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ projectId: fc.uuid(), supervisorIds: fc.array(fc.uuid(), { maxLength: 2 }) }),
          {
            maxLength: 8,
          },
        ),
        fc.array(fc.boolean(), { maxLength: 8 }),
        (projects, filedFlags) => {
          const filed = new Set(
            projects.filter((_, i) => filedFlags[i] === true).map((p) => p.projectId),
          );
          const missing = selectMissing(projects, filed);
          for (const project of projects) {
            const expected = project.supervisorIds.length > 0 && !filed.has(project.projectId);
            expect(missing.includes(project)).toBe(expected);
          }
        },
      ),
      { seed: 15 },
    );
  });

  it('the deadline holds for exactly 6 of every 24 Karachi hours, from 18:00', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (hour, minute) => {
          const karachi = Date.UTC(2026, 9, 29, hour, minute) - 5 * 3600_000;
          expect(isPastDeadline(new Date(karachi))).toBe(hour >= 18);
        },
      ),
      { seed: 15 },
    );
  });
});
