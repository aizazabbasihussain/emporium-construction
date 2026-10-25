import { RuleViolationError } from '@emporium/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAT_STEEL,
  createValuationKit,
  eventCount,
  ITEM_CEMENT,
  ITEM_SAND,
  ITEM_STEEL,
  STORE_A,
  STORE_B,
  TODAY,
  TOMORROW,
  type ValuationKit,
} from '../test-support.js';

const DAY_3 = '2026-10-27';
const at = (day: string) => new Date(`${day}T10:00:00Z`);

let kit: ValuationKit;
beforeAll(async () => {
  kit = await createValuationKit();
}, 60_000);
afterAll(() => kit.close());

const receipt = (
  storeId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
  date: string,
) =>
  kit.tx((tx) =>
    kit.valuation.recordReceipt(
      { storeId, itemId, quantity, unitCost, postingDate: date, idempotencyKey: kit.key() },
      kit.actor,
      tx,
    ),
  );

const issue = (storeId: string, itemId: string, quantity: string, date: string) =>
  kit.tx((tx) =>
    kit.valuation.valueIssue(
      { storeId, itemId, quantity, postingDate: date, idempotencyKey: kit.key() },
      kit.actor,
      tx,
    ),
  );

const stock = (storeId: string, itemId: string) =>
  kit.valuation.getStockValue(kit.db, storeId, itemId);

const total = async () => Number((await kit.valuation.getTotalValue(kit.db, {})).totalValue);

describe('changing the method (AC-1, AC-2, AC-4, T-5, T-9)', () => {
  let firstIssueValue: string;
  let firstIssueId: string;

  it('keeps valuing by weighted average until the new policy starts', async () => {
    kit.now.current = at(TODAY);
    await receipt(STORE_A, ITEM_CEMENT, '100', '1200', TODAY);
    await receipt(STORE_A, ITEM_CEMENT, '100', '1300', TODAY);
    await receipt(STORE_A, ITEM_STEEL, '10', '100', TODAY);
    const first = await issue(STORE_A, ITEM_CEMENT, '50', TODAY);
    firstIssueValue = first.value;
    firstIssueId = first.movementId;
    expect(first.value).toBe('62500.00');

    // The owner approves FIFO for the company from tomorrow; steel stays on weighted average.
    await kit.activatePolicy({ scope: 'company', method: 'fifo', effectiveFrom: TOMORROW });
    await kit.activatePolicy({
      scope: 'category',
      categoryId: CAT_STEEL,
      method: 'weighted_average',
      effectiveFrom: TOMORROW,
    });
    const again = await issue(STORE_A, ITEM_CEMENT, '10', TODAY);
    expect(again.method).toBe('weighted_average');
    expect(again.value).toBe('12500.00');
    expect((await kit.valuation.resolvePolicy(kit.db, ITEM_CEMENT, TODAY)).method).toBe(
      'weighted_average',
    );
    expect((await kit.valuation.resolvePolicy(kit.db, ITEM_CEMENT, TOMORROW)).method).toBe('fifo');
  });

  it('AC-1: switching leaves the total value unchanged and later issues are valued by FIFO', async () => {
    const before = await total();
    expect(before).toBe(175000 + 1000);
    kit.now.current = at(TOMORROW);
    const transitions = await kit.valuation.reports.transitions(kit.db, { limit: 50, offset: 0 });
    expect(transitions.total).toBe(0);

    // The first movement on the new date converts the key lazily (BR-11).
    await receipt(STORE_A, ITEM_CEMENT, '100', '1400', TOMORROW);
    const log = await kit.valuation.reports.transitions(kit.db, { limit: 50, offset: 0 });
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({
      storeId: STORE_A,
      itemId: ITEM_CEMENT,
      fromMethod: 'weighted_average',
      toMethod: 'fifo',
      quantity: '140.0000',
      valueBefore: '175000.00',
      valueAfter: '175000.00',
    });
    expect(await total()).toBe(before + 140000);

    // 140 at the carried-over 1,250 average, then 20 at 1,400: oldest first.
    const out = await issue(STORE_A, ITEM_CEMENT, '160', TOMORROW);
    expect(out.method).toBe('fifo');
    expect(out.parts.map((p) => [p.quantity, p.value])).toEqual([
      ['140.0000', '175000.00'],
      ['20.0000', '28000.00'],
    ]);
    expect(out.value).toBe('203000.00');
    expect(await stock(STORE_A, ITEM_CEMENT)).toMatchObject({
      quantity: '80.0000',
      value: '112000.00',
    });
  });

  it('AC-2: the category override changes the method for that category only', async () => {
    const steel = await issue(STORE_A, ITEM_STEEL, '4', TOMORROW);
    expect(steel.method).toBe('weighted_average');
    expect(steel.value).toBe('400.00');
    const sand = await receipt(STORE_A, ITEM_SAND, '1', '10', TOMORROW);
    expect(sand.method).toBe('fifo');
  });

  it('AC-4: no past issue changes its recorded value after a policy change', async () => {
    const rows = await kit.db.query<{ value: string }>(
      'select value::text as value from val_movements where id = $1',
      [firstIssueId],
    );
    expect(rows[0]?.value).toBe(firstIssueValue);
    const parts = await kit.db.query<{ value: string }>(
      'select value::text as value from val_consumptions where movement_id = $1',
      [firstIssueId],
    );
    expect(parts.map((p) => p.value)).toEqual([firstIssueValue]);
  });

  it('T-9: per-category values add up to the total across mixed methods', async () => {
    const all = await kit.valuation.getTotalValue(kit.db, {});
    const byItem = await Promise.all(
      [ITEM_CEMENT, ITEM_STEEL, ITEM_SAND].map(async (itemId) =>
        Number((await kit.valuation.getTotalValue(kit.db, { itemId })).totalValue),
      ),
    );
    expect(byItem.reduce((a, b) => a + b, 0)).toBeCloseTo(Number(all.totalValue), 6);
    expect(new Set(all.items.map((i) => i.method))).toEqual(new Set(['fifo', 'weighted_average']));
  });

  it('T-5: FIFO back to weighted average by the explicit admin run holds the value; a second run is a no-op', async () => {
    await kit.activatePolicy({
      scope: 'company',
      method: 'weighted_average',
      effectiveFrom: DAY_3,
    });
    // A key that is empty when the policy flips still converts, with nothing to carry over.
    await receipt(STORE_B, ITEM_SAND, '2', '3', TOMORROW);
    await issue(STORE_B, ITEM_SAND, '2', TOMORROW);

    kit.now.current = at(DAY_3);
    const before = await total();
    const completed = await kit.tx((tx) => kit.valuation.requestTransition(kit.actor, tx));
    const cement = completed.find((t) => t.itemId === ITEM_CEMENT);
    expect(cement).toMatchObject({
      fromMethod: 'fifo',
      toMethod: 'weighted_average',
      quantity: '80.0000',
      valueBefore: '112000.00',
      valueAfter: '112000.00',
    });
    expect(completed.find((t) => t.storeId === STORE_B)).toMatchObject({
      quantity: '0.0000',
      valueBefore: '0.00',
    });
    expect(completed.some((t) => t.itemId === ITEM_STEEL)).toBe(false);
    expect(await total()).toBe(before);
    expect(await stock(STORE_A, ITEM_CEMENT)).toMatchObject({
      method: 'weighted_average',
      averageCost: '1400.0000',
    });
    expect(await eventCount(kit.db, 'valuation.transition.completed')).toBeGreaterThanOrEqual(
      completed.length,
    );

    expect(await kit.tx((tx) => kit.valuation.requestTransition(kit.actor, tx))).toEqual([]);
    // A movement after the explicit run does not convert again.
    const again = await issue(STORE_A, ITEM_CEMENT, '10', DAY_3);
    expect(again.method).toBe('weighted_average');
    expect(again.value).toBe('14000.00');
  });

  it('picks up a key whose last movement is dated after today', async () => {
    const future = '2026-11-30';
    await receipt(STORE_B, ITEM_CEMENT, '1', '1', future);
    const done = await kit.tx((tx) => kit.valuation.requestTransition(kit.actor, tx));
    expect(done).toEqual([]);
  });
});

describe('a transition that would change the value is aborted (T-5, BR-10)', () => {
  it('rolls everything back and reports the mismatch', async () => {
    const own = await createValuationKit();
    try {
      const s = STORE_A;
      const post = (type: 'r' | 'i', quantity: string, date: string) =>
        own.tx((tx) =>
          type === 'r'
            ? own.valuation.recordReceipt(
                {
                  storeId: s,
                  itemId: ITEM_STEEL,
                  quantity,
                  unitCost: '10',
                  postingDate: date,
                  idempotencyKey: own.key(),
                },
                own.actor,
                tx,
              )
            : own.valuation.valueIssue(
                {
                  storeId: s,
                  itemId: ITEM_STEEL,
                  quantity,
                  postingDate: date,
                  idempotencyKey: own.key(),
                },
                own.actor,
                tx,
              ),
        );
      await post('r', '5', TODAY);
      await own.activatePolicy({ scope: 'company', method: 'fifo', effectiveFrom: TOMORROW });
      own.now.current = at(TOMORROW);

      await own.db.exec(`
        create function val_tamper() returns trigger language plpgsql as $$
        begin new.remaining_value := new.remaining_value + 1; return new; end; $$;
        create trigger val_tamper_trigger before insert on val_layers
          for each row execute function val_tamper();`);
      await expect(post('i', '1', TOMORROW)).rejects.toBeInstanceOf(RuleViolationError);
      await expect(post('i', '1', TOMORROW)).rejects.toThrow(/change stock value/);

      const rows = await own.db.query<{ method: string }>('select method from val_keys');
      expect(rows[0]?.method).toBe('weighted_average');
      expect((await own.valuation.reports.transitions(own.db, { limit: 5, offset: 0 })).total).toBe(
        0,
      );
      expect((await own.valuation.getStockValue(own.db, s, ITEM_STEEL)).value).toBe('50.00');

      await own.db.exec('drop trigger val_tamper_trigger on val_layers');
      expect((await post('i', '1', TOMORROW)).value).toBe('10.00');
    } finally {
      await own.close();
    }
  }, 60_000);
});
