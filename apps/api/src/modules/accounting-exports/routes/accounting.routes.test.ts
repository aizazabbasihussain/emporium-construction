import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  SUPERVISOR,
  createAccountingKit,
  receiptRow,
  taggable,
  type AccountingKit,
} from '../test-support.js';
import type {
  AccountDto,
  BackfillPlanDto,
  ExportInfoDto,
  RuleDto,
  RunResultDto,
  TagDto,
  UntaggedPageDto,
} from '../types.js';

let kit: AccountingKit;
beforeAll(async () => {
  kit = await createAccountingKit();
}, 120_000);
afterAll(() => kit.close());

interface Call {
  method?: 'GET' | 'POST' | 'PUT';
  url: string;
  user?: string;
  body?: unknown;
  key?: string;
  anonymous?: boolean;
}

const call = async ({ method = 'GET', url, user = ACCOUNTANT, body, key, anonymous }: Call) =>
  kit.app.inject({
    method,
    url,
    headers: {
      ...(anonymous === true ? {} : await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const json = async <T>(request: Promise<Awaited<ReturnType<typeof call>>>) => {
  const response = await request;
  return { status: response.statusCode, body: response.json<T>() };
};
const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

let keys = 0;
const newKey = () => `accounting-key-${++keys}`;
const period = { from: '2026-10-01', to: '2026-10-31' };

describe('GET /exports', () => {
  it('lists the fourteen exports for the accountant and management', async () => {
    for (const user of [ACCOUNTANT, MANAGEMENT]) {
      const { status, body } = await json<ExportInfoDto[]>(call({ url: '/exports', user }));
      expect(status).toBe(200);
      expect(body).toHaveLength(14);
      expect(body.map((e) => e.code)).toContain('withholding_report');
    }
  });

  it('refuses callers without an accounting permission and anonymous callers', async () => {
    for (const user of [NOBODY, SUPERVISOR]) {
      expect((await call({ url: '/exports', user })).statusCode).toBe(403);
    }
    expect((await call({ url: '/exports', anonymous: true })).statusCode).toBe(401);
  });
});

describe('POST /exports/:code/run', () => {
  const url = '/exports/receipts_register/run';
  const script = () => {
    kit.loaded.receipts_register = {
      rows: [receiptRow('RV-9', '500.00')],
      control: { amount: '500.00', withheld: '0.00' },
    };
  };

  it('runs the export and returns the run, the warning count and the file ids (idempotent)', async () => {
    script();
    const key = newKey();
    const first = await json<RunResultDto>(call({ method: 'POST', url, body: period, key }));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      untagged: 1,
      totals: { amount: '500.00', withheld: '0.00' },
      run: { exportCode: 'receipts_register', rowCount: 1, schemaVersion: 1 },
    });
    expect(first.body.files.xlsx).toBe(first.body.run.fileId);
    const retry = await json<RunResultDto>(call({ method: 'POST', url, body: period, key }));
    expect(retry.status).toBe(201);
    expect(retry.body.run.id).toBe(first.body.run.id);
    const runs = await json<{ items: { id: string }[]; total: number }>(
      call({ url: '/exports/runs?exportCode=receipts_register&limit=5' }),
    );
    expect(runs.body.items.filter((r) => r.id === first.body.run.id)).toHaveLength(1);
  });

  it('refuses a caller who may only read, bad input, an unknown export and a mismatch', async () => {
    script();
    const denied = await json(call({ method: 'POST', url, body: period, user: NOBODY }));
    expect([denied.status, errorCode(denied.body)]).toEqual([403, 'permission_denied']);
    // A caller without the permission learns nothing from the validation message.
    const deniedBad = await json(call({ method: 'POST', url, body: {}, user: NOBODY }));
    expect(deniedBad.status).toBe(403);
    for (const bad of [
      {},
      { from: '2026-10-01' },
      { from: '01/10/2026', to: '2026-10-31' },
      { ...period, partyId: 'not-a-uuid' },
      { ...period, side: 'both' },
    ]) {
      expect((await call({ method: 'POST', url, body: bad })).statusCode).toBe(400);
    }
    const backwards = await json(
      call({ method: 'POST', url, body: { from: '2026-10-31', to: '2026-10-01' } }),
    );
    expect([backwards.status, errorCode(backwards.body)]).toEqual([400, 'invalid_period']);
    expect(
      (await call({ method: 'POST', url: '/exports/trial_balance/run', body: period })).statusCode,
    ).toBe(400);
    expect((await call({ method: 'POST', url, body: period, key: '' })).statusCode).toBe(400);
    kit.loaded.receipts_register = {
      rows: [receiptRow('RV-9', '500.00')],
      control: { amount: '499.00', withheld: '0.00' },
    };
    const mismatch = await json(call({ method: 'POST', url, body: period }));
    expect([mismatch.status, errorCode(mismatch.body)]).toEqual([422, 'control_total_mismatch']);
  });

  it('accepts every optional filter', async () => {
    script();
    const response = await call({
      method: 'POST',
      url,
      body: {
        ...period,
        partyId: '018f7c7c-bbbb-7000-8000-000000000001',
        projectId: '018f7c7c-bbbb-7000-8000-000000000002',
        accountId: '018f7c7c-bbbb-7000-8000-000000000003',
        storeId: '018f7c7c-bbbb-7000-8000-000000000004',
        categoryId: '018f7c7c-bbbb-7000-8000-000000000005',
        side: 'payable',
        authorityCode: 'FBR',
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('GET /exports/runs', () => {
  it('pages the history and refuses a bad page size or export code', async () => {
    const { status, body } = await json<{ items: unknown[]; limit: number }>(
      call({ url: '/exports/runs?limit=2', user: MANAGEMENT }),
    );
    expect(status).toBe(200);
    expect(body.limit).toBe(2);
    expect((await call({ url: '/exports/runs?limit=0' })).statusCode).toBe(400);
    expect((await call({ url: '/exports/runs?exportCode=nope' })).statusCode).toBe(400);
    expect((await call({ url: '/exports/runs', user: NOBODY })).statusCode).toBe(403);
  });
});

describe('the untagged queue and tags', () => {
  it('lists untagged lines, then bulk-tags them (idempotent) and they leave the queue', async () => {
    kit.docs.length = 0;
    kit.docs.push(
      taggable('r-1', { date: '2026-10-02' }),
      taggable('r-2', { date: '2026-10-03', docType: 'bill' }),
    );
    const before = await json<UntaggedPageDto>(
      call({ url: '/accounting/untagged?from=2026-10-01&to=2026-10-31&limit=10' }),
    );
    expect(before.status).toBe(200);
    expect(before.body.byType).toEqual({ invoice: 1, bill: 1 });
    expect(before.body.items.map((i) => i.sourceDocId)).toEqual(['r-1', 'r-2']);
    const key = newKey();
    const tagBody = {
      targets: [
        { docType: 'invoice', docId: 'r-1' },
        { docType: 'bill', docId: 'r-2', lineRef: '' },
      ],
      accountCode: '4100',
    };
    const tagged = await json<TagDto[]>(
      call({ method: 'PUT', url: '/accounting/tags', body: tagBody, key }),
    );
    expect(tagged.status).toBe(200);
    expect(tagged.body.map((t) => t.accountCode)).toEqual(['4100', '4100']);
    const replay = await json<TagDto[]>(
      call({ method: 'PUT', url: '/accounting/tags', body: tagBody, key }),
    );
    expect(replay.body.map((t) => t.sourceDocId)).toEqual(['r-1', 'r-2']);
    const after = await json<UntaggedPageDto>(
      call({ url: '/accounting/untagged?docType=invoice' }),
    );
    expect(after.body.total).toBe(0);
  });

  it('refuses bad input, an unknown account and callers who may not tag or see', async () => {
    const put = (body: unknown, user = ACCOUNTANT) =>
      call({ method: 'PUT', url: '/accounting/tags', body, user });
    expect((await put({ targets: [], accountCode: '4100' })).statusCode).toBe(400);
    expect(
      (await put({ targets: [{ docType: 'journal', docId: 'x' }], accountCode: '4100' }))
        .statusCode,
    ).toBe(400);
    const unknown = await json(
      put({ targets: [{ docType: 'bill', docId: 'x' }], accountCode: '9999' }),
    );
    expect([unknown.status, errorCode(unknown.body)]).toEqual([400, 'unknown_account']);
    expect(
      (await put({ targets: [{ docType: 'bill', docId: 'x' }], accountCode: '4100' }, MANAGEMENT))
        .statusCode,
    ).toBe(403);
    expect((await call({ url: '/accounting/untagged', user: NOBODY })).statusCode).toBe(403);
    expect((await call({ url: '/accounting/untagged?from=bad' })).statusCode).toBe(400);
    const backwards = await json(
      call({ url: '/accounting/untagged?from=2026-10-31&to=2026-10-01' }),
    );
    expect([backwards.status, errorCode(backwards.body)]).toEqual([400, 'invalid_period']);
  });
});

describe('the mapping rules and the chart', () => {
  const rule = {
    sourceDocType: 'receipt',
    debitAccountCode: '1110',
    creditAccountCode: '1210',
    effectiveFrom: '2026-07-01',
  };

  it('creates and changes a rule (idempotent, with a version check)', async () => {
    const key = newKey();
    const created = await json<RuleDto>(
      call({ method: 'PUT', url: '/accounting/mapping-rules', body: rule, key }),
    );
    expect(created.status).toBe(201);
    const replay = await json<RuleDto>(
      call({ method: 'PUT', url: '/accounting/mapping-rules', body: rule, key }),
    );
    expect(replay.body.id).toBe(created.body.id);
    const changeBody = {
      ...rule,
      id: created.body.id,
      version: 1,
      condition: { method: 'cash' },
      active: false,
    };
    const changed = await json<RuleDto>(
      call({ method: 'PUT', url: '/accounting/mapping-rules', body: changeBody }),
    );
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      condition: { method: 'cash' },
      active: false,
      version: 2,
    });
    const stale = await json(
      call({ method: 'PUT', url: '/accounting/mapping-rules', body: changeBody }),
    );
    expect([stale.status, errorCode(stale.body)]).toEqual([409, 'version_conflict']);
    const missing = await json(
      call({
        method: 'PUT',
        url: '/accounting/mapping-rules',
        body: { ...changeBody, id: '018f7c7c-bbbb-7000-8000-999999999999' },
      }),
    );
    expect([missing.status, errorCode(missing.body)]).toEqual([404, 'rule_not_found']);
    const list = await json<RuleDto[]>(
      call({ url: '/accounting/mapping-rules', user: MANAGEMENT }),
    );
    expect(list.body.some((r) => r.id === created.body.id)).toBe(true);
  });

  it('refuses a rule that is not valid and callers who may not manage rules', async () => {
    const put = (body: unknown, user = ACCOUNTANT) =>
      call({ method: 'PUT', url: '/accounting/mapping-rules', body, user });
    expect((await put({ ...rule, sourceDocType: 'journal' })).statusCode).toBe(400);
    expect((await put({ ...rule, effectiveFrom: 'July' })).statusCode).toBe(400);
    expect((await put({ ...rule, condition: { kind: 5 } })).statusCode).toBe(400);
    const idOnly = await json(put({ ...rule, id: '018f7c7c-bbbb-7000-8000-000000000009' }));
    expect([idOnly.status, errorCode(idOnly.body)]).toEqual([400, 'invalid_rule']);
    const versionOnly = await json(put({ ...rule, version: 1 }));
    expect([versionOnly.status, errorCode(versionOnly.body)]).toEqual([400, 'invalid_rule']);
    const unknown = await json(put({ ...rule, debitAccountCode: '9999' }));
    expect([unknown.status, errorCode(unknown.body)]).toEqual([400, 'unknown_account']);
    expect((await put(rule, MANAGEMENT)).statusCode).toBe(403);
    expect((await call({ url: '/accounting/mapping-rules', user: NOBODY })).statusCode).toBe(403);
  });

  it('lists the chart and switches an account off and on (version checked)', async () => {
    const chart = await json<AccountDto[]>(call({ url: '/accounting/accounts' }));
    expect(chart.status).toBe(200);
    expect(chart.body.length).toBeGreaterThan(60);
    const off = await json<AccountDto>(
      call({
        method: 'PUT',
        url: '/accounting/accounts/6500',
        body: { active: false, version: 1 },
        key: newKey(),
      }),
    );
    expect(off.body).toMatchObject({ code: '6500', active: false, version: 2 });
    const hidden = await json<AccountDto[]>(call({ url: '/accounting/accounts' }));
    expect(hidden.body.some((a) => a.code === '6500')).toBe(false);
    const all = await json<AccountDto[]>(
      call({ url: '/accounting/accounts?includeInactive=true' }),
    );
    expect(all.body.some((a) => a.code === '6500')).toBe(true);
    const stale = await json(
      call({ method: 'PUT', url: '/accounting/accounts/6500', body: { active: true, version: 1 } }),
    );
    expect([stale.status, errorCode(stale.body)]).toEqual([409, 'version_conflict']);
    const gone = await json(
      call({ method: 'PUT', url: '/accounting/accounts/9999', body: { active: true, version: 1 } }),
    );
    expect([gone.status, errorCode(gone.body)]).toEqual([404, 'account_not_found']);
    expect(
      (await call({ method: 'PUT', url: '/accounting/accounts/6500', body: { active: 'yes' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'PUT',
          url: '/accounting/accounts/6500',
          body: { active: true, version: 2 },
          user: MANAGEMENT,
        })
      ).statusCode,
    ).toBe(403);
    expect((await call({ url: '/accounting/accounts?includeInactive=maybe' })).statusCode).toBe(
      400,
    );
  });
});

describe('the backfill', () => {
  it('shows a dry run, then commits it, with no body needed', async () => {
    kit.docs.length = 0;
    await kit.db.query('delete from acc_tags');
    kit.docs.push(taggable('bf-1', { docType: 'receipt', date: '2026-10-04' }));
    const dry = await json<BackfillPlanDto>(
      call({ method: 'POST', url: '/accounting/backfill/dry-run' }),
    );
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, considered: 1 });
    const planned = dry.body.tagged;
    expect(planned).toBeGreaterThanOrEqual(0);
    const commit = await json<BackfillPlanDto>(
      call({
        method: 'POST',
        url: '/accounting/backfill/commit',
        body: { from: '2026-10-01', to: '2026-10-31' },
        key: newKey(),
      }),
    );
    expect(commit.body).toMatchObject({ dryRun: false, tagged: planned });
    expect(
      (await call({ method: 'POST', url: '/accounting/backfill/commit', body: { from: 'x' } }))
        .statusCode,
    ).toBe(400);
    for (const url of ['/accounting/backfill/dry-run', '/accounting/backfill/commit']) {
      expect((await call({ method: 'POST', url, user: MANAGEMENT })).statusCode).toBe(403);
    }
  });
});
