import { summarizeChains, type ChainRow, type CostStatus } from '@emporium/domain/costing';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PM, createProjectsKit, uid, type ProjectsKit } from '../test-support.js';
import {
  costCodeUsage,
  projectUsesParty,
  searchProjects,
  taskPercentsFor,
} from './projects.repo.js';

let kit: ProjectsKit;
beforeAll(async () => {
  kit = await createProjectsKit();
}, 120_000);
afterAll(() => kit.close());

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return String(error);
  }
  return undefined;
};

describe('the ledger cannot be changed (AC-4)', () => {
  it('refuses update, delete and truncate for any caller', async () => {
    const project = await kit.activeProject();
    const id = await kit.cost(project.id);
    expect(
      await failure(() =>
        kit.db.query('update prj_cost_entries set amount = 1 where id = $1', [id]),
      ),
    ).toContain('append-only');
    expect(
      await failure(() => kit.db.query('delete from prj_cost_entries where id = $1', [id])),
    ).toContain('append-only');
    expect(await failure(() => kit.db.query('truncate prj_cost_entries'))).toContain('append-only');
    const [row] = await kit.db.query<{ amount: string }>(
      'select amount::text as amount from prj_cost_entries where id = $1',
      [id],
    );
    expect(row?.amount).toBe('100.00');
  });

  it('refuses a project entry without an object and an overhead entry with one', async () => {
    const insert = (n: number, type: string, objectId: string | null) =>
      kit.db.query(
        `insert into prj_cost_entries (id, cost_object_type, cost_object_id, cost_code_id, amount, status,
           source_module, source_doc_type, source_doc_id, chain_key, entry_date, idempotency_key)
         values ($1, $2, $3, $4, 1, 'committed', 'm', 't', $5, $6, '2026-10-25', $6)`,
        [uid(8000 + n), type, objectId, kit.codes['100'], uid(8100), `direct-${n}`],
      );
    expect(await failure(() => insert(1, 'project', null))).toContain('check');
    expect(await failure(() => insert(2, 'overhead', uid(1)))).toContain('check');
  });
});

describe('summary view equals the sum of chains (BR-6, BR-7, T-5)', () => {
  it('property: random operation sequences, and reversing everything gives zero', async () => {
    const operation = fc.record({
      chain: fc.integer({ min: 0, max: 3 }),
      reverse: fc.boolean(),
      cents: fc.integer({ min: 1, max: 5_000_000 }),
    });
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { maxLength: 14 }), async (operations) => {
        run += 1;
        const project = await kit.activeProject();
        const heads = new Map<number, { id: string; status: CostStatus }>();
        let step = 0;
        for (const { chain, reverse, cents } of operations) {
          step += 1;
          const head = heads.get(chain);
          if (head === undefined || head.status === 'reversed') {
            const id = await kit.cost(project.id, {
              amount: (cents / 100).toFixed(2),
              sourceDocId: uid(100 + chain),
              sourceLineId: null,
              idempotencyKey: `prop-${run}-${step}`,
            });
            heads.set(chain, { id, status: 'committed' });
          } else if (reverse || head.status === 'posted') {
            const next = await kit.db.transaction((tx) =>
              kit.projects.reverseCost(head.id, 'random reversal', tx),
            );
            heads.set(chain, { id: next.id, status: 'reversed' });
          } else {
            const to = head.status === 'committed' ? 'approved' : 'posted';
            const next = await kit.db.transaction((tx) =>
              kit.projects.transitionCost(head.id, to, tx),
            );
            heads.set(chain, { id: next.id, status: to });
          }
        }
        const rows = await kit.db.query<ChainRow & { seq: string }>(
          `select seq::text as seq, chain_key as chain, cost_code_id as "costCodeId",
                  amount::text as amount, status
             from prj_cost_entries where cost_object_id = $1`,
          [project.id],
        );
        const model = summarizeChains(rows.map((r) => ({ ...r, seq: Number(r.seq) })));
        const object = { type: 'project', id: project.id } as const;
        expect((await kit.projects.getCostSummary(kit.db, object)).totals).toEqual(model);
        for (const head of heads.values()) {
          if (head.status !== 'reversed') {
            await kit.db.transaction((tx) => kit.projects.reverseCost(head.id, 'undo all', tx));
          }
        }
        expect((await kit.projects.getCostSummary(kit.db, object)).totals).toEqual({
          committed: '0.00',
          approved: '0.00',
          posted: '0.00',
        });
      }),
      { numRuns: 12 },
    );
  }, 120_000);
});

describe('repository queries', () => {
  it('tells master data whether a cost code or client is in use', async () => {
    const project = await kit.activeProject();
    expect(await costCodeUsage(kit.db, kit.codes['400'] as string)).toEqual({
      postedCosts: false,
      openBudgetLines: false,
    });
    await kit.cost(project.id, { costCodeId: kit.codes['400'] as string });
    await kit.db.transaction((tx) =>
      kit.projects.service.replaceBudget(
        project.id,
        [{ costCodeId: kit.codes['300'] as string, budgetAmount: '5' }],
        project.version,
        kit.actorFor(PM),
        tx,
      ),
    );
    expect((await costCodeUsage(kit.db, kit.codes['400'] as string)).postedCosts).toBe(true);
    expect((await costCodeUsage(kit.db, kit.codes['300'] as string)).openBudgetLines).toBe(true);
    expect(await projectUsesParty(kit.db, kit.clientId)).toBe(true);
    expect(await projectUsesParty(kit.db, uid(9500))).toBe(false);
  });

  it('master data refuses to switch off a cost code with costs and open budget lines', async () => {
    const project = await kit.activeProject();
    const code = kit.codes['600'] as string;
    await kit.db.transaction((tx) =>
      kit.projects.service.replaceBudget(
        project.id,
        [{ costCodeId: code, budgetAmount: '5' }],
        project.version,
        kit.actorFor(PM),
        tx,
      ),
    );
    await kit.cost(project.id, { costCodeId: code });
    const used = await kit.masterData.costing.getCostCode(kit.db, code);
    const attempt = () =>
      kit.db.transaction((tx) =>
        kit.masterData.costing.updateCostCode(
          used.id,
          { code: used.code, name: used.name, kind: used.kind, active: false },
          used.version,
          { userId: uid(1), requestId: null },
          tx,
        ),
      );
    expect(await failure(attempt)).toContain('posted costs and open budget lines');
  });

  it('searches with a scope filter and a text filter, and groups task percents', async () => {
    const a = await kit.project({ name: 'Scoped alpha' });
    await kit.project({ name: 'Scoped beta' });
    const literal = await searchProjects(kit.db, {
      q: 'Scoped_',
      onlyIds: [a.id],
      limit: 10,
      offset: 0,
    });
    expect(literal.total).toBe(0);
    const some = await searchProjects(kit.db, {
      q: 'Scoped',
      onlyIds: [a.id],
      limit: 10,
      offset: 0,
    });
    expect(some.rows.map((r) => r.id)).toEqual([a.id]);
    const none = await searchProjects(kit.db, { q: '  ', onlyIds: [], limit: 10, offset: 0 });
    expect(none.total).toBe(0);
    await kit.db.transaction((tx) =>
      kit.projects.service.createTask(
        a.id,
        { name: 't', percentComplete: 30 },
        kit.actorFor(PM),
        tx,
      ),
    );
    const percents = await taskPercentsFor(kit.db, [a.id, uid(9501)]);
    expect([...percents.entries()]).toEqual([[a.id, [30]]]);
  });
});
