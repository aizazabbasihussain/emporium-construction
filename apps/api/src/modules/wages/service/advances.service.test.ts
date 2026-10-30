import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  auditCount,
  createWagesKit,
  eventCount,
  type WagesKit,
} from '../test-support.js';

let kit: WagesKit;
beforeAll(async () => {
  kit = await createWagesKit();
}, 60_000);
afterAll(() => kit.close());

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

describe('advances (T-3)', () => {
  it('issues an advance with its instalment and reports the worker', async () => {
    const worker = await kit.worker();
    const actor = await kit.actorFor(ACCOUNTANT);
    const created = await kit.db.transaction((tx) =>
      kit.wages.advances.create(
        {
          workerId: worker.id,
          amount: '12000',
          monthlyRecovery: '3000.5',
          issuedOn: '2026-09-01',
          note: '  Family emergency  ',
        },
        actor,
        tx,
      ),
    );
    expect(created).toMatchObject({
      workerId: worker.id,
      workerCode: worker.code,
      workerName: worker.fullName,
      amount: '12000.00',
      monthlyRecovery: '3000.50',
      issuedOn: '2026-09-01',
      balance: '12000.00',
      status: 'open',
      note: 'Family emergency',
      version: 1,
    });
    expect(await kit.wages.getWorkerAdvanceBalance(kit.db, worker.id)).toBe('12000.00');
    expect(await auditCount(kit.db, 'wages.advance.create')).toBeGreaterThan(0);
    expect(await eventCount(kit.db, 'wages.advance.changed')).toBeGreaterThan(0);
  });

  it('stores a blank note as none and a missing one too', async () => {
    const worker = await kit.worker();
    const actor = await kit.actorFor(ACCOUNTANT);
    const make = (note?: string) =>
      kit.db.transaction((tx) =>
        kit.wages.advances.create(
          {
            workerId: worker.id,
            amount: '100',
            monthlyRecovery: '50',
            issuedOn: '2026-09-01',
            note,
          },
          actor,
          tx,
        ),
      );
    expect((await make('   ')).note).toBeNull();
    expect((await make()).note).toBeNull();
  });

  it('validates the amounts, the date and the worker', async () => {
    const worker = await kit.worker();
    const actor = await kit.actorFor(ACCOUNTANT);
    const make = (over: Record<string, string>, workerId = worker.id) =>
      kit.db.transaction((tx) =>
        kit.wages.advances.create(
          { workerId, amount: '100', monthlyRecovery: '50', issuedOn: '2026-09-01', ...over },
          actor,
          tx,
        ),
      );
    expect(await codeOf(() => make({ amount: '0' }))).toBe('advance_amount_invalid');
    expect(await codeOf(() => make({ monthlyRecovery: '0' }))).toBe('advance_recovery_invalid');
    expect(await codeOf(() => make({ monthlyRecovery: '101' }))).toBe('advance_recovery_invalid');
    expect(await codeOf(() => make({ issuedOn: '2026-13-45' }))).not.toBe('no error');
    expect(await codeOf(() => make({}, '018f7c7c-ffff-7000-8000-000000000996'))).toBe(
      'worker_not_found',
    );
  });

  it('lists the advances of a worker by status and pages them', async () => {
    const worker = await kit.worker();
    const other = await kit.worker();
    const first = await kit.advance(worker.id, '1000', '500', '2026-08-01');
    await kit.advance(worker.id, '2000', '500', '2026-09-01');
    await kit.advance(other.id, '3000', '500', '2026-09-01');
    const actor = await kit.actorFor(ACCOUNTANT);
    const mine = await kit.wages.advances.list(
      kit.db,
      { workerId: worker.id, limit: 10, offset: 0 },
      actor,
    );
    expect(mine.total).toBe(2);
    expect(mine.items.map((a) => a.amount)).toEqual(['2000.00', '1000.00']);
    expect(mine.items.every((a) => a.workerName === worker.fullName)).toBe(true);
    const paged = await kit.wages.advances.list(
      kit.db,
      { workerId: worker.id, status: 'open', limit: 1, offset: 1 },
      actor,
    );
    expect(paged.items.map((a) => a.id)).toEqual([first.id]);
    const closed = await kit.wages.advances.list(
      kit.db,
      { workerId: worker.id, status: 'closed', limit: 10, offset: 0 },
      actor,
    );
    expect(closed.items).toEqual([]);
  });

  it('reports a zero balance for a worker who owes nothing', async () => {
    const worker = await kit.worker();
    expect(await kit.wages.getWorkerAdvanceBalance(kit.db, worker.id)).toBe('0.00');
  });
});
