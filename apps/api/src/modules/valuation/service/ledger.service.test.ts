import { NotFoundError, RuleViolationError, ValidationError } from '@emporium/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  CAT_STEEL,
  createValuationKit,
  eventCount,
  ITEM_CEMENT,
  ITEM_SAND,
  ITEM_STEEL,
  STORE_A,
  STORE_B,
  TODAY,
  type ValuationKit,
} from '../test-support.js';

// Cement is kept by weighted average (company default, H-07); steel has a FIFO category override.

let kit: ValuationKit;
beforeAll(async () => {
  kit = await createValuationKit();
  await kit.activatePolicy({
    scope: 'category',
    categoryId: CAT_STEEL,
    method: 'fifo',
    effectiveFrom: TODAY,
  });
}, 60_000);
afterAll(() => kit.close());

const receipt = (
  storeId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
  date = TODAY,
) =>
  kit.tx((tx) =>
    kit.valuation.recordReceipt(
      { storeId, itemId, quantity, unitCost, postingDate: date, idempotencyKey: kit.key() },
      kit.actor,
      tx,
    ),
  );

const issue = (storeId: string, itemId: string, quantity: string, date = TODAY, key = kit.key()) =>
  kit.tx((tx) =>
    kit.valuation.valueIssue(
      { storeId, itemId, quantity, postingDate: date, idempotencyKey: key },
      kit.actor,
      tx,
    ),
  );

const stock = (storeId: string, itemId: string) =>
  kit.valuation.getStockValue(kit.db, storeId, itemId);

const store = (n: number) => `018f7a7a-4444-7000-8000-${String(n).padStart(12, '0')}`;

describe('worked example (T-1, T-2, T-3)', () => {
  it('weighted average: 100 at 1,200 then 100 at 1,300, issue 50 = 62,500; 187,500 remains', async () => {
    const s = store(1);
    await receipt(s, ITEM_CEMENT, '100', '1200');
    await receipt(s, ITEM_CEMENT, '100', '1300');
    const out = await issue(s, ITEM_CEMENT, '50');
    expect(out.value).toBe('62500.00');
    expect(out.unitCost).toBe('1250.0000');
    expect(out.method).toBe('weighted_average');
    expect(out.parts).toEqual([
      { layerId: null, quantity: '50.0000', unitCost: '1250.0000', value: '62500.00' },
    ]);
    expect(await stock(s, ITEM_CEMENT)).toMatchObject({
      quantity: '150.0000',
      value: '187500.00',
      averageCost: '1250.0000',
      method: 'weighted_average',
    });
  });

  it('FIFO: the same movements issue 50 = 60,000; 190,000 remains', async () => {
    const s = store(2);
    await receipt(s, ITEM_STEEL, '100', '1200');
    await receipt(s, ITEM_STEEL, '100', '1300');
    const out = await issue(s, ITEM_STEEL, '50');
    expect(out.value).toBe('60000.00');
    expect(out.method).toBe('fifo');
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]?.layerId).not.toBeNull();
    expect(await stock(s, ITEM_STEEL)).toMatchObject({ quantity: '150.0000', value: '190000.00' });
  });

  it('FIFO spreads an issue over layers, oldest first, with exact part values', async () => {
    const s = store(3);
    await receipt(s, ITEM_STEEL, '10', '1.5');
    await receipt(s, ITEM_STEEL, '10', '2');
    const out = await issue(s, ITEM_STEEL, '15');
    expect(out.parts.map((p) => [p.quantity, p.value])).toEqual([
      ['10.0000', '15.00'],
      ['5.0000', '10.00'],
    ]);
    expect(out.value).toBe('25.00');
    expect((await stock(s, ITEM_STEEL)).value).toBe('10.00');
  });

  it('weighted average: issuing everything clears the rounding residue (T-2)', async () => {
    const s = store(4);
    await receipt(s, ITEM_SAND, '3', '0.3333');
    const values = [];
    for (let i = 0; i < 3; i++) values.push((await issue(s, ITEM_SAND, '1')).value);
    expect(values).toEqual(['0.33', '0.34', '0.33']);
    expect(await stock(s, ITEM_SAND)).toMatchObject({ quantity: '0.0000', value: '0.00' });
  });
});

describe('refusals and idempotency (BR-7, BR-12, T-7)', () => {
  it('refuses an issue beyond the known quantity and writes nothing', async () => {
    const s = store(10);
    await receipt(s, ITEM_CEMENT, '5', '10');
    const before = await kit.valuation.reports.movements(kit.db, {
      storeId: s,
      limit: 50,
      offset: 0,
    });
    await expect(issue(s, ITEM_CEMENT, '5.0001')).rejects.toBeInstanceOf(RuleViolationError);
    await expect(issue(store(11), ITEM_STEEL, '1')).rejects.toThrow(/insufficient|only/);
    const after = await kit.valuation.reports.movements(kit.db, {
      storeId: s,
      limit: 50,
      offset: 0,
    });
    expect(after.total).toBe(before.total);
    expect((await stock(s, ITEM_CEMENT)).value).toBe('50.00');
  });

  it('a repeated idempotency key returns the first result and records nothing new', async () => {
    const s = store(12);
    const key = kit.key();
    const input = {
      storeId: s,
      itemId: ITEM_CEMENT,
      quantity: '10',
      unitCost: '7.5',
      postingDate: TODAY,
      idempotencyKey: key,
    };
    const first = await kit.tx((tx) => kit.valuation.recordReceipt(input, kit.actor, tx));
    const again = await kit.tx((tx) => kit.valuation.recordReceipt(input, kit.actor, tx));
    expect(again).toEqual(first);
    expect((await stock(s, ITEM_CEMENT)).quantity).toBe('10.0000');

    const issueKey = kit.key();
    const out = await issue(s, ITEM_CEMENT, '4', TODAY, issueKey);
    expect(await issue(s, ITEM_CEMENT, '4', TODAY, issueKey)).toEqual(out);
    expect((await stock(s, ITEM_CEMENT)).quantity).toBe('6.0000');
  });

  it('validates quantities, costs and dates', async () => {
    const s = store(13);
    await expect(receipt(s, ITEM_CEMENT, '0', '1')).rejects.toBeInstanceOf(ValidationError);
    await expect(receipt(s, ITEM_CEMENT, '1', '-1')).rejects.toThrow(/negative/);
    await expect(receipt(s, ITEM_CEMENT, '1', '1.00001')).rejects.toThrow(/at most 4/);
    await expect(receipt(s, ITEM_CEMENT, '1', '1', '2026-13-45')).rejects.toThrow(/Invalid/);
    await expect(issue(s, ITEM_CEMENT, 'abc')).rejects.toBeInstanceOf(ValidationError);
    await expect(receipt(s, '018f7a7a-3333-7000-8000-000000009999', '1', '1')).rejects.toThrow(
      /does not exist/,
    );
  });

  it('writes an audit entry and an outbox event for every movement', async () => {
    const audits = await auditCount(kit.db, 'valuation.receipt');
    const events = await eventCount(kit.db, 'valuation.movement.recorded');
    await receipt(store(14), ITEM_CEMENT, '1', '1');
    expect(await auditCount(kit.db, 'valuation.receipt')).toBe(audits + 1);
    expect(await eventCount(kit.db, 'valuation.movement.recorded')).toBe(events + 1);
  });

  it('takes a zero-cost receipt (a gift) without value', async () => {
    const s = store(15);
    const out = await receipt(s, ITEM_CEMENT, '4', '0');
    expect(out.value).toBe('0.00');
    expect((await issue(s, ITEM_CEMENT, '4')).value).toBe('0.00');
  });
});

describe('dates', () => {
  it('values a back-dated posting with the key’s latest date, never going back', async () => {
    const s = store(20);
    await receipt(s, ITEM_CEMENT, '10', '5', '2026-10-25');
    await receipt(s, ITEM_CEMENT, '10', '5', '2026-10-24');
    expect((await stock(s, ITEM_CEMENT)).quantity).toBe('20.0000');
    const rows = await kit.db.query<{ last_posting_date: string }>(
      `select to_char(last_posting_date, 'YYYY-MM-DD') as last_posting_date from val_keys
        where store_id = $1`,
      [s],
    );
    expect(rows[0]?.last_posting_date).toBe('2026-10-25');
  });
});

describe('transfers (BR-8)', () => {
  it('moves value between stores exactly: weighted average', async () => {
    const [from, to] = [store(30), store(31)] as [string, string];
    await receipt(from, ITEM_CEMENT, '3', '0.3333');
    const key = kit.key();
    const moved = await kit.tx((tx) =>
      kit.valuation.recordTransfer(
        {
          fromStoreId: from,
          toStoreId: to,
          itemId: ITEM_CEMENT,
          quantity: '2',
          postingDate: TODAY,
          idempotencyKey: key,
        },
        kit.actor,
        tx,
      ),
    );
    expect(moved.out.type).toBe('transfer_out');
    expect(moved.in.type).toBe('transfer_in');
    expect(moved.out.value).toBe(moved.in.value);
    expect(moved.in.unitCost).toBe('0.3350');
    const [a, b] = [await stock(from, ITEM_CEMENT), await stock(to, ITEM_CEMENT)];
    expect(a.quantity).toBe('1.0000');
    expect(b.quantity).toBe('2.0000');
    expect(Number(a.value) + Number(b.value)).toBeCloseTo(1, 10);
    expect(b.value).toBe(moved.out.value);

    const replay = await kit.tx((tx) =>
      kit.valuation.recordTransfer(
        {
          fromStoreId: from,
          toStoreId: to,
          itemId: ITEM_CEMENT,
          quantity: '2',
          postingDate: TODAY,
          idempotencyKey: key,
        },
        kit.actor,
        tx,
      ),
    );
    expect(replay).toEqual(moved);
    expect((await stock(to, ITEM_CEMENT)).quantity).toBe('2.0000');
  });

  it('moves value between stores exactly: FIFO keeps the layer value', async () => {
    const [from, to] = [store(32), store(33)] as [string, string];
    await receipt(from, ITEM_STEEL, '3', '1.5');
    const moved = await kit.tx((tx) =>
      kit.valuation.recordTransfer(
        {
          fromStoreId: from,
          toStoreId: to,
          itemId: ITEM_STEEL,
          quantity: '3',
          postingDate: TODAY,
          idempotencyKey: kit.key(),
        },
        kit.actor,
        tx,
      ),
    );
    expect(moved.in.value).toBe('4.50');
    expect(moved.in.method).toBe('fifo');
    expect(await stock(from, ITEM_STEEL)).toMatchObject({ quantity: '0.0000', value: '0.00' });
    expect(await stock(to, ITEM_STEEL)).toMatchObject({ quantity: '3.0000', value: '4.50' });
  });

  it('refuses a transfer to the same store and one beyond the quantity', async () => {
    const s = store(34);
    await receipt(s, ITEM_CEMENT, '1', '1');
    const transfer = (toStoreId: string, quantity: string) =>
      kit.tx((tx) =>
        kit.valuation.recordTransfer(
          {
            fromStoreId: s,
            toStoreId,
            itemId: ITEM_CEMENT,
            quantity,
            postingDate: TODAY,
            idempotencyKey: kit.key(),
          },
          kit.actor,
          tx,
        ),
      );
    await expect(transfer(s, '1')).rejects.toThrow(/two different stores/);
    await expect(transfer(STORE_B, '2')).rejects.toBeInstanceOf(RuleViolationError);
    expect((await stock(s, ITEM_CEMENT)).quantity).toBe('1.0000');
  });

  it('reports a half-recorded transfer instead of inventing a result', async () => {
    await kit.db.query(
      `insert into val_movements (id, store_id, item_id, type, quantity, value, unit_cost, method_used, posting_date, idempotency_key)
       values ($1, $2, $3, 'transfer_out', 1, 1, 1, 'weighted_average', $4, 'stray:out')`,
      ['018f7c7c-9999-7000-8000-000000000001', STORE_A, ITEM_CEMENT, TODAY],
    );
    await expect(
      kit.tx((tx) =>
        kit.valuation.recordTransfer(
          {
            fromStoreId: STORE_A,
            toStoreId: STORE_B,
            itemId: ITEM_CEMENT,
            quantity: '1',
            postingDate: TODAY,
            idempotencyKey: 'stray',
          },
          kit.actor,
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('returns (BR-9, T-8)', () => {
  const giveBack = (issueRef: string, quantity: string, key = kit.key()) =>
    kit.tx((tx) =>
      kit.valuation.recordReturn(
        { issueRef, quantity, postingDate: TODAY, idempotencyKey: key },
        kit.actor,
        tx,
      ),
    );

  it('weighted average: restores the issue cost, in pieces, to the paisa', async () => {
    const s = store(40);
    await receipt(s, ITEM_CEMENT, '3', '3.3333');
    const out = await issue(s, ITEM_CEMENT, '3');
    expect(out.value).toBe('10.00');
    const first = await giveBack(out.movementId, '1');
    expect(first.type).toBe('return');
    expect(first.value).toBe('3.33');
    const second = await giveBack(out.movementId, '2');
    expect(second.value).toBe('6.67');
    expect(await stock(s, ITEM_CEMENT)).toMatchObject({ quantity: '3.0000', value: '10.00' });
    await expect(giveBack(out.movementId, '0.0001')).rejects.toThrow(/still out/);
  });

  it('FIFO: returned stock goes back in front of newer layers, at the old cost', async () => {
    const s = store(41);
    await receipt(s, ITEM_STEEL, '10', '1');
    const out = await issue(s, ITEM_STEEL, '10');
    await receipt(s, ITEM_STEEL, '10', '5');
    const back = await giveBack(out.movementId, '4');
    expect(back.value).toBe('4.00');
    expect(back.method).toBe('fifo');
    const next = await issue(s, ITEM_STEEL, '4');
    expect(next.value).toBe('4.00');
    expect(next.parts).toHaveLength(1);
    expect(await stock(s, ITEM_STEEL)).toMatchObject({ quantity: '10.0000', value: '50.00' });
  });

  it('a return replayed with its key restores nothing twice; unknown and non-issue refs fail', async () => {
    const s = store(42);
    const received = await receipt(s, ITEM_CEMENT, '5', '2');
    const out = await issue(s, ITEM_CEMENT, '5');
    const key = kit.key();
    const first = await giveBack(out.movementId, '2', key);
    expect(await giveBack(out.movementId, '2', key)).toEqual(first);
    expect((await stock(s, ITEM_CEMENT)).quantity).toBe('2.0000');
    await expect(giveBack('018f7c7c-9999-7000-8000-00000000ffff', '1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(giveBack(received.movementId, '1')).rejects.toThrow(/Only an issue/);
  });
});

describe('source references', () => {
  it('keeps the document an issue and its return came from', async () => {
    const s = store(60);
    await receipt(s, ITEM_STEEL, '4', '2');
    const out = await kit.tx((tx) =>
      kit.valuation.valueIssue(
        {
          storeId: s,
          itemId: ITEM_STEEL,
          quantity: '4',
          postingDate: TODAY,
          sourceRef: 'ISS-1',
          idempotencyKey: kit.key(),
        },
        kit.actor,
        tx,
      ),
    );
    const back = await kit.tx((tx) =>
      kit.valuation.recordReturn(
        {
          issueRef: out.movementId,
          quantity: '1',
          postingDate: TODAY,
          sourceRef: 'RET-1',
          idempotencyKey: kit.key(),
        },
        kit.actor,
        tx,
      ),
    );
    const rows = await kit.db.query<{ source_ref: string }>(
      'select source_ref from val_movements where id = any($1::uuid[]) order by seq',
      [[out.movementId, back.movementId]],
    );
    expect(rows.map((r) => r.source_ref)).toEqual(['ISS-1', 'RET-1']);
    const layers = await kit.db.query<{ receipt_ref: string | null }>(
      'select receipt_ref from val_layers where store_id = $1 order by received_seq, created_at',
      [s],
    );
    expect(layers.map((l) => l.receipt_ref)).toContain('RET-1');
  });
});

describe('concurrency (T-10)', () => {
  it('two issues on the same key at once never take more than is there', async () => {
    const s = store(50);
    await receipt(s, ITEM_STEEL, '10', '3');
    const results = await Promise.allSettled([
      issue(s, ITEM_STEEL, '6'),
      issue(s, ITEM_STEEL, '6'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await stock(s, ITEM_STEEL)).toMatchObject({ quantity: '4.0000', value: '12.00' });
  });
});

describe('append-only records (BR-14)', () => {
  it('has no way to change or remove a movement or what it consumed', async () => {
    await expect(kit.db.query("update val_movements set source_ref = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(kit.db.query('delete from val_consumptions')).rejects.toThrow(/append-only/);
    await expect(kit.db.query('delete from val_return_parts')).rejects.toThrow(/append-only/);
    await expect(kit.db.exec('truncate val_return_parts')).rejects.toThrow(/append-only/);
  });
});
