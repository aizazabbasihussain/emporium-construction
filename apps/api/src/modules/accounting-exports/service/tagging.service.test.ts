import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  createAccountingKit,
  taggable,
  type AccountingKit,
} from '../test-support.js';
import type { Db, RuleInput } from '../types.js';

let kit: AccountingKit;
beforeAll(async () => {
  kit = await createAccountingKit();
}, 120_000);
afterAll(() => kit.close());
beforeEach(async () => {
  kit.docs.length = 0;
  await kit.db.query('delete from acc_tags');
  await kit.db.query('delete from acc_mapping_rules');
});

const accountant = () => kit.actorFor(ACCOUNTANT);
const inTx = <T>(run: (tx: Db) => Promise<T>) => kit.db.transaction(run);

const invoiceRule: RuleInput = {
  sourceDocType: 'invoice',
  debitAccountCode: '1210',
  creditAccountCode: '4100',
  effectiveFrom: '2026-07-01',
};

describe('the chart of accounts', () => {
  it('lists the accepted chart and hides switched-off accounts by default', async () => {
    const all = await kit.tagging.listAccounts(kit.db, false, accountant());
    expect(all.length).toBeGreaterThan(60);
    expect(all.find((a) => a.code === '4100')).toMatchObject({
      name: 'Contract revenue, construction',
      type: 'income',
      parentCode: '4000',
      active: true,
    });
    const off = await inTx((tx) =>
      kit.tagging.setAccountActive('6900', { active: false, version: 1 }, accountant(), tx),
    );
    expect(off).toMatchObject({ code: '6900', active: false, version: 2 });
    const visible = await kit.tagging.listAccounts(kit.db, false, accountant());
    expect(visible.some((a) => a.code === '6900')).toBe(false);
    const everything = await kit.tagging.listAccounts(kit.db, true, accountant());
    expect(everything.some((a) => a.code === '6900')).toBe(true);
    await inTx((tx) =>
      kit.tagging.setAccountActive('6900', { active: true, version: 2 }, accountant(), tx),
    );
  });

  it('refuses a stale version, an unknown account and a caller without the permission', async () => {
    await expect(
      inTx((tx) =>
        kit.tagging.setAccountActive('6900', { active: false, version: 99 }, accountant(), tx),
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      inTx((tx) =>
        kit.tagging.setAccountActive('9999', { active: false, version: 1 }, accountant(), tx),
      ),
    ).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(
      inTx((tx) =>
        kit.tagging.setAccountActive(
          '6900',
          { active: false, version: 1 },
          kit.actorFor(MANAGEMENT),
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      kit.tagging.listAccounts(kit.db, false, kit.actorFor(NOBODY)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('mapping rules (BR-1)', () => {
  it('creates, lists and changes a rule, with defaults for the optional fields', async () => {
    const created = await inTx((tx) => kit.tagging.createRule(invoiceRule, accountant(), tx));
    expect(created).toMatchObject({
      sourceDocType: 'invoice',
      condition: {},
      debitAccountCode: '1210',
      creditAccountCode: '4100',
      effectiveFrom: '2026-07-01',
      active: true,
      version: 1,
    });
    const changed = await inTx((tx) =>
      kit.tagging.updateRule(
        created.id,
        {
          ...invoiceRule,
          condition: { kind: 'advance' },
          creditAccountCode: '2400',
          active: false,
          version: 1,
        },
        accountant(),
        tx,
      ),
    );
    expect(changed).toMatchObject({
      condition: { kind: 'advance' },
      creditAccountCode: '2400',
      active: false,
      version: 2,
    });
    expect(await kit.tagging.listRules(kit.db, accountant())).toEqual([changed]);
  });

  it('refuses unknown or switched-off accounts, stale versions, missing rules and strangers', async () => {
    await expect(
      inTx((tx) =>
        kit.tagging.createRule({ ...invoiceRule, debitAccountCode: '9999' }, accountant(), tx),
      ),
    ).rejects.toMatchObject({ code: 'unknown_account' });
    await inTx((tx) =>
      kit.tagging.setAccountActive('6600', { active: false, version: 1 }, accountant(), tx),
    );
    await expect(
      inTx((tx) =>
        kit.tagging.createRule({ ...invoiceRule, creditAccountCode: '6600' }, accountant(), tx),
      ),
    ).rejects.toMatchObject({ code: 'inactive_account' });
    await inTx((tx) =>
      kit.tagging.setAccountActive('6600', { active: true, version: 2 }, accountant(), tx),
    );
    const rule = await inTx((tx) => kit.tagging.createRule(invoiceRule, accountant(), tx));
    await expect(
      inTx((tx) =>
        kit.tagging.updateRule(rule.id, { ...invoiceRule, version: 7 }, accountant(), tx),
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      inTx((tx) =>
        kit.tagging.updateRule(
          '018f7c7c-bbbb-7000-8000-999999999999',
          { ...invoiceRule, version: 1 },
          accountant(),
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'rule_not_found' });
    await expect(
      inTx((tx) => kit.tagging.createRule(invoiceRule, kit.actorFor(MANAGEMENT), tx)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('tags (T-3, AC-2)', () => {
  it('tags a line by hand and replaces the tag when the accountant changes it', async () => {
    const first = await inTx((tx) =>
      kit.tagging.tagTransaction({ docType: 'bill', docId: 'b1' }, '5100', accountant(), tx),
    );
    expect(first).toMatchObject({
      sourceDocType: 'bill',
      sourceDocId: 'b1',
      lineRef: '',
      accountCode: '5100',
      method: 'manual',
      taggedBy: ACCOUNTANT,
    });
    const second = await inTx((tx) =>
      kit.tagging.tagTransaction(
        { docType: 'bill', docId: 'b1', lineRef: '' },
        '5300',
        accountant(),
        tx,
      ),
    );
    expect(second.accountCode).toBe('5300');
    const [counted] = await kit.db.query<{ n: string }>(
      `select count(*) as n from acc_tags where source_doc_id = 'b1'`,
    );
    expect(Number(counted?.n)).toBe(1);
  });

  it('bulk-tags many lines with one account', async () => {
    const tags = await inTx((tx) =>
      kit.tagging.tagMany(
        [
          { docType: 'invoice', docId: 'i1' },
          { docType: 'invoice', docId: 'i2', lineRef: '1' },
        ],
        '4100',
        accountant(),
        tx,
      ),
    );
    expect(tags.map((t) => [t.sourceDocId, t.lineRef, t.accountCode])).toEqual([
      ['i1', '', '4100'],
      ['i2', '1', '4100'],
    ]);
  });

  it('refuses an unknown account and a caller who may not tag', async () => {
    await expect(
      inTx((tx) =>
        kit.tagging.tagTransaction({ docType: 'bill', docId: 'b1' }, '9999', accountant(), tx),
      ),
    ).rejects.toMatchObject({ code: 'unknown_account' });
    await expect(
      inTx((tx) =>
        kit.tagging.tagMany(
          [{ docType: 'bill', docId: 'b1' }],
          '5100',
          kit.actorFor(MANAGEMENT),
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      inTx((tx) =>
        kit.tagging.tagTransaction(
          { docType: 'bill', docId: 'b1' },
          '5100',
          kit.actorFor(MANAGEMENT),
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('writes an audit entry and an event for every tag', async () => {
    await inTx((tx) =>
      kit.tagging.tagTransaction({ docType: 'bill', docId: 'audit-1' }, '5100', accountant(), tx),
    );
    const audit = await kit.db.query<{ action: string }>(
      `select action from sys_audit_log where entity_id = 'bill:audit-1:'`,
    );
    expect(audit.map((a) => a.action)).toEqual(['accounting.tag.set']);
    const events = await kit.db.query<{ n: string }>(
      `select count(*) as n from sys_outbox where type = 'accounting.tag.changed'
        and payload->>'docId' = 'audit-1'`,
    );
    expect(Number(events[0]?.n)).toBe(1);
  });
});

describe('the untagged queue (T-4, AC-2)', () => {
  it('lists untagged lines by date with the suggestion and a count by type', async () => {
    kit.docs.push(
      taggable('i1', { date: '2026-10-03' }),
      taggable('i2', { date: '2026-10-01' }),
      taggable('b1', { docType: 'bill', date: '2026-10-02', attrs: { kind: 'purchase' } }),
      taggable('i3', { date: '2026-09-30' }),
    );
    await inTx((tx) => kit.tagging.createRule(invoiceRule, accountant(), tx));
    await inTx((tx) =>
      kit.tagging.tagTransaction({ docType: 'invoice', docId: 'i3' }, '4100', accountant(), tx),
    );
    const page = await kit.tagging.listUntagged(
      kit.db,
      { from: '2026-10-01', to: '2026-10-31', limit: 10, offset: 0 },
      accountant(),
    );
    expect(page.byType).toEqual({ invoice: 2, bill: 1 });
    expect(page.total).toBe(3);
    expect(page.items.map((i) => [i.sourceDocId, i.suggestedAccountCode])).toEqual([
      ['i2', '4100'],
      ['b1', null],
      ['i1', '4100'],
    ]);
    expect(page.items[0]).toMatchObject({
      sourceDocType: 'invoice',
      number: 'INV-i2',
      party: 'Synthetic Client',
      amount: '1000.00',
    });
  });

  it('filters by type, pages, and reads the whole history when no period is given', async () => {
    kit.docs.push(
      taggable('i1', { date: '2026-10-01' }),
      taggable('i2', { date: '2026-10-02' }),
      taggable('b1', { docType: 'bill', date: '2026-10-02' }),
    );
    const invoices = await kit.tagging.listUntagged(
      kit.db,
      { docType: 'invoice', limit: 1, offset: 1 },
      accountant(),
    );
    expect(invoices.total).toBe(2);
    expect(invoices.items.map((i) => i.sourceDocId)).toEqual(['i2']);
    expect(invoices.byType).toEqual({ invoice: 2, bill: 1 });
  });

  it('refuses a period that ends before it starts and a caller without any accounting permission', async () => {
    await expect(
      kit.tagging.listUntagged(
        kit.db,
        { from: '2026-10-31', to: '2026-10-01', limit: 10, offset: 0 },
        accountant(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_period' });
    await expect(
      kit.tagging.listUntagged(kit.db, { limit: 10, offset: 0 }, kit.actorFor(NOBODY)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('rule precedence and retagging (T-3)', () => {
  it('uses the more specific rule, and a later rule change never retags a tagged line', async () => {
    kit.docs.push(
      taggable('i1', { attrs: { kind: 'advance' } }),
      taggable('i2', { attrs: { kind: 'project_stage' } }),
    );
    const general = await inTx((tx) => kit.tagging.createRule(invoiceRule, accountant(), tx));
    await inTx((tx) =>
      kit.tagging.createRule(
        { ...invoiceRule, condition: { kind: 'advance' }, creditAccountCode: '2400' },
        accountant(),
        tx,
      ),
    );
    const done = await inTx((tx) => kit.tagging.backfill({ dryRun: false }, accountant(), tx));
    expect(done).toMatchObject({ tagged: 2, unmatched: 0, alreadyTagged: 0 });
    const read = async () =>
      (
        await kit.db.query<{ source_doc_id: string; account_code: string; method: string }>(
          'select source_doc_id, account_code, method from acc_tags order by source_doc_id',
        )
      ).map((t) => [t.source_doc_id, t.account_code, t.method]);
    expect(await read()).toEqual([
      ['i1', '2400', 'rule'],
      ['i2', '4100', 'rule'],
    ]);

    // The rule changes; the tags made under the old rule stay as they were.
    await inTx((tx) =>
      kit.tagging.updateRule(
        general.id,
        { ...invoiceRule, creditAccountCode: '4110', version: 1 },
        accountant(),
        tx,
      ),
    );
    kit.docs.push(taggable('i3'));
    const again = await inTx((tx) => kit.tagging.backfill({ dryRun: false }, accountant(), tx));
    expect(again).toMatchObject({ tagged: 1, alreadyTagged: 2 });
    expect(await read()).toEqual([
      ['i1', '2400', 'rule'],
      ['i2', '4100', 'rule'],
      ['i3', '4110', 'rule'],
    ]);

    // A manual tag survives a later backfill as well.
    await inTx((tx) =>
      kit.tagging.tagTransaction({ docType: 'invoice', docId: 'i2' }, '4120', accountant(), tx),
    );
    await inTx((tx) => kit.tagging.backfill({ dryRun: false }, accountant(), tx));
    expect((await read())[1]).toEqual(['i2', '4120', 'manual']);
  });
});

describe('backfill (T-7, BR-9)', () => {
  beforeEach(async () => {
    kit.docs.push(
      taggable('i1', { date: '2026-10-01' }),
      taggable('b1', { docType: 'bill', date: '2026-10-02' }),
      taggable('i2', { date: '2026-08-01' }),
    );
    await inTx((tx) => kit.tagging.createRule(invoiceRule, accountant(), tx));
  });

  it('a dry run reports what would be tagged and changes nothing', async () => {
    const auditedBefore = (
      await kit.db.query(`select 1 from sys_audit_log where action = 'accounting.backfill.commit'`)
    ).length;
    const plan = await inTx((tx) => kit.tagging.backfill({ dryRun: true }, accountant(), tx));
    expect(plan).toMatchObject({
      dryRun: true,
      considered: 3,
      alreadyTagged: 0,
      tagged: 2,
      unmatched: 1,
    });
    expect(plan.sample.map((s) => [s.sourceDocId, s.accountCode])).toEqual([
      ['i1', '4100'],
      ['i2', '4100'],
    ]);
    const [counted] = await kit.db.query<{ n: string }>('select count(*) as n from acc_tags');
    expect(Number(counted?.n)).toBe(0);
    const audits = await kit.db.query(
      `select 1 from sys_audit_log where action = 'accounting.backfill.commit'`,
    );
    expect(audits).toHaveLength(auditedBefore);
  });

  it('a commit writes the tags once, audited, inside the period asked', async () => {
    const done = await inTx((tx) =>
      kit.tagging.backfill(
        { dryRun: false, from: '2026-10-01', to: '2026-10-31' },
        accountant(),
        tx,
      ),
    );
    expect(done).toMatchObject({ dryRun: false, considered: 2, tagged: 1, unmatched: 1 });
    const [counted] = await kit.db.query<{ n: string }>('select count(*) as n from acc_tags');
    expect(Number(counted?.n)).toBe(1);
    const audits = await kit.db.query(
      `select 1 from sys_audit_log where action = 'accounting.backfill.commit'`,
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('does not count a line that was tagged between the plan and the write', async () => {
    kit.docs.push(taggable('i1', { date: '2026-10-01' }));
    const done = await inTx((tx) => kit.tagging.backfill({ dryRun: false }, accountant(), tx));
    expect(done.tagged).toBe(2);
  });

  it('refuses a bad period and a caller who may not tag', async () => {
    await expect(
      inTx((tx) =>
        kit.tagging.backfill(
          { dryRun: true, from: '2026-10-31', to: '2026-10-01' },
          accountant(),
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_period' });
    await expect(
      inTx((tx) => kit.tagging.backfill({ dryRun: true }, kit.actorFor(MANAGEMENT), tx)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
