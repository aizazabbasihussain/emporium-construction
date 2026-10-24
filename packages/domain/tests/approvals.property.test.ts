import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decide, type RecordedAction, type StepDef } from '../src/approvals/index.js';

const roles = ['r1', 'r2', 'r3'] as const;
const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'] as const;

const ruleArb = fc
  .array(
    fc.record({
      roleCode: fc.constantFrom(...roles),
      minApprovers: fc.integer({ min: 1, max: 3 }),
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((steps): StepDef[] => steps.map((s, i) => ({ stepNo: i + 1, ...s })));

const attemptArb = fc.record({
  actorId: fc.constantFrom(...users),
  actorRoles: fc.subarray([...roles]),
});

/** T-8: a request is only approved when every step's quorum is met by distinct, eligible, non-requester users. */
describe('approval quorum property (T-8)', () => {
  it('never reaches approved without every quorum being met', () => {
    fc.assert(
      fc.property(
        ruleArb,
        fc.constantFrom(...users),
        fc.array(attemptArb, { maxLength: 40 }),
        (steps, requesterId, attempts) => {
          const history: RecordedAction[] = [];
          let currentStep = 1;
          let approved = false;
          for (const attempt of attempts) {
            let outcome;
            try {
              outcome = decide({
                steps,
                currentStep,
                requesterId,
                actorId: attempt.actorId,
                actorRoles: attempt.actorRoles,
                action: 'approve',
                comment: null,
                history,
              });
            } catch {
              continue;
            }
            history.push({ stepNo: currentStep, actorId: attempt.actorId, action: 'approve' });
            expect(attempt.actorId).not.toBe(requesterId);
            expect(attempt.actorRoles).toContain(steps[currentStep - 1]?.roleCode);
            currentStep = outcome.currentStep;
            if (outcome.status === 'approved') {
              approved = true;
              break;
            }
          }
          if (approved) {
            const approvers = history.map((h) => h.actorId);
            expect(new Set(approvers).size).toBe(approvers.length);
            for (const step of steps) {
              expect(history.filter((h) => h.stepNo === step.stepNo).length).toBeGreaterThanOrEqual(
                step.minApprovers,
              );
            }
          }
        },
      ),
    );
  });
});
