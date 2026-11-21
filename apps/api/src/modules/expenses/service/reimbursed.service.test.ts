import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExpensesKit, type ExpensesKit } from '../test-support.js';

let kit: ExpensesKit;
beforeAll(async () => {
  kit = await createExpensesKit();
}, 120_000);
afterAll(() => kit.close());

describe('expenses reimbursed for a project as of a date (P2-08)', () => {
  it('counts the project lines of posted claims from the day they were posted', async () => {
    const project = await kit.project();
    const other = await kit.project();
    const reimbursed = (projectId: string, asOf: string) =>
      kit.expenses.getReimbursedForProject(kit.db, projectId, asOf);
    const onProject = (amount: string) =>
      kit.line({ costObjectType: 'project', costObjectId: project.id, amount });

    // Posted on 25 October: 1,200.50 and 300.00 on the project, 99.00 on overhead (not counted).
    kit.now.current = new Date('2026-10-25T10:00:00Z');
    await kit.posted({
      lines: [onProject('1200.50'), onProject('300.00'), kit.line({ amount: '99.00' })],
    });
    // An approved claim that has not been posted is not reimbursed.
    await kit.approved({ lines: [onProject('77.00')] });
    // Posted on 27 October: 40.00 more.
    kit.now.current = new Date('2026-10-27T10:00:00Z');
    await kit.posted({ lines: [{ ...onProject('40.00'), expenseDate: '2026-10-26' }] });

    expect(await reimbursed(project.id, '2026-10-24')).toBe('0.00');
    expect(await reimbursed(project.id, '2026-10-25')).toBe('1500.50');
    expect(await reimbursed(project.id, '2026-10-26')).toBe('1500.50');
    expect(await reimbursed(project.id, '2026-10-27')).toBe('1540.50');
    expect(await reimbursed(other.id, '2026-10-27')).toBe('0.00');
    await expect(reimbursed(project.id, 'tomorrow')).rejects.toMatchObject({
      code: 'invalid_date',
    });
    kit.now.current = new Date('2026-10-25T10:00:00Z');
  });
});
