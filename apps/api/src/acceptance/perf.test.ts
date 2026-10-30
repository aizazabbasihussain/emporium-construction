import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { client, val, type Client } from './scenario-kit.js';
import { loadSyntheticCompany, pilotCompany } from './seed.js';

/** Performance sanity of P1-21 BR-5 on 6 projects, 50 workers and 3 months of attendance. */
describe('Gate A performance (BR-5)', () => {
  let h: Harness;
  let c: Client;
  let projectIds: string[];
  let teamIds: string[];
  const memberIds = new Map<string, string[]>();

  beforeAll(async () => {
    // Teams are formed the day before the first sheet, so every sheet falls inside their membership.
    h = await createHarness({ now: new Date('2026-07-31T05:00:00Z') });
    c = client(h);
    await loadSyntheticCompany(h, pilotCompany(false));
    for (const [key, value] of [
      ['workforce.working_days_basis', 26],
      ['attendance.overtime_multiplier', '1.5'],
    ] as const) {
      const current = await c.send('admin', 'GET', `/admin/settings/${key}`);
      await c.send('admin', 'PUT', `/admin/settings/${key}`, {
        value,
        version: Number(val(current.body, 'version')),
      });
    }
    const projects = await c.send<{ items: { id: string }[] }>('pm', 'GET', '/projects');
    projectIds = projects.body.items.map((project) => project.id);
    for (const id of projectIds) {
      await c.send('pm', 'POST', `/projects/${id}/status`, {
        status: 'active',
        version: await c.versionOf('pm', `/projects/${id}`),
      });
    }
    const teams = await c.send<{ id: string }[]>('pm', 'GET', '/workforce/teams');
    teamIds = teams.body.map((team) => team.id);
    for (const teamId of teamIds) {
      const team = await c.send<{ members: { workerId: string }[] }>(
        'pm',
        'GET',
        `/workforce/teams/${teamId}`,
      );
      memberIds.set(
        teamId,
        team.body.members.map((member) => member.workerId),
      );
    }
    // Three months of working days (Monday to Saturday), one approved sheet per team and day.
    const days: string[] = [];
    for (let day = new Date('2026-08-01T00:00:00Z'); day <= new Date('2026-10-31T00:00:00Z');) {
      if (day.getUTCDay() !== 0) days.push(day.toISOString().slice(0, 10));
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    }
    for (const date of days) {
      h.now.current = new Date(`${date}T14:00:00Z`);
      for (const [index, teamId] of teamIds.entries()) {
        const sheet = await c.send('pm', 'PUT', `/attendance/sheets/${teamId}/${date}`, {
          entries: (memberIds.get(teamId) ?? []).map((workerId) => ({
            workerId,
            status: 'present',
            allocations: [{ projectId: projectIds[index], fraction: '1' }],
          })),
        });
        const url = `/attendance/sheets/${val(sheet.body, 'id')}`;
        await c.send('pm', 'POST', `${url}/submit`, { version: await c.versionOf('pm', url) });
      }
      await c.approveInbox('pm2');
    }
  }, 900_000);
  afterAll(() => h.close());

  it('serves every list endpoint under 500 ms at the 95th percentile', async () => {
    const endpoints = [
      '/projects',
      '/master/items?limit=50',
      '/master/parties',
      '/workforce/workers',
      '/workforce/teams',
      '/attendance/sheets?limit=50',
      '/inventory/ledger',
      '/inventory/stock',
      '/procurement/purchase-orders',
      '/expenses/claims',
      '/dpr/reports',
      '/crm/leads',
      '/valuation/movements',
      '/wages/periods',
      '/reports/project-cost',
      '/reports/labour',
    ];
    const slow: string[] = [];
    for (const endpoint of endpoints) {
      const timings: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        const res = await h.call('owner', 'GET', endpoint);
        timings.push(performance.now() - started);
        expect(res.status, endpoint).toBe(200);
      }
      timings.sort((a, b) => a - b);
      const p95 = timings[Math.ceil(timings.length * 0.95) - 1] as number;
      if (p95 >= 500) slow.push(`${endpoint} p95 ${p95.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  }, 300_000);

  it('calculates the wages of 50 workers for a month in under 3 seconds', async () => {
    const period = await c.send('accountant', 'POST', '/wages/periods', { year: 2026, month: 10 });
    const started = performance.now();
    const calculated = await c.send(
      'accountant',
      'POST',
      `/wages/periods/${val(period.body, 'id')}/calculate`,
      {},
    );
    const elapsed = performance.now() - started;
    expect(val<unknown[]>(calculated.body, 'lines')).toHaveLength(50);
    expect(elapsed).toBeLessThan(3000);
  }, 60_000);

  it('answers the five heaviest queries from an index', async () => {
    const queries: [string, string, unknown[]][] = [
      [
        'stock ledger of one item in one store',
        `select * from inv_ledger where store_id = $1 and item_id = $2 and ownership = 'company' order by seq`,
        [projectIds[0], projectIds[0]],
      ],
      [
        'cost entries of one project',
        `select * from prj_cost_entries where cost_object_type = 'project' and cost_object_id = $1`,
        [projectIds[0]],
      ],
      [
        'latest entry of a cost chain',
        'select * from prj_cost_entries where chain_key = $1 order by seq desc limit 1',
        ['chain'],
      ],
      [
        'valuation movements of one item in one store',
        'select * from val_movements where store_id = $1 and item_id = $2 order by seq',
        [projectIds[0], projectIds[0]],
      ],
      [
        'open FIFO layers of one item in one store',
        'select * from val_layers where store_id = $1 and item_id = $2 and remaining_qty > 0 order by received_seq',
        [projectIds[0], projectIds[0]],
      ],
      [
        'attendance entries of one worker',
        'select * from att_entries where worker_id = $1',
        [projectIds[0]],
      ],
    ];
    for (const [name, sql, params] of queries) {
      // With sequential scans switched off, a plan without an index scan means no usable index exists.
      const plan = await h.db.transaction(async (tx) => {
        await tx.exec('set local enable_seqscan = off');
        const rows = await tx.query<{ 'QUERY PLAN': string }>(`explain ${sql}`, params);
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(plan, name).toMatch(/Index/);
    }
  });
});
