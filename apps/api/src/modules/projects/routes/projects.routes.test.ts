import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  createProjectsKit,
  uid,
  type ProjectsKit,
} from '../test-support.js';
import type { PageResult, ProjectDetailDto, ProjectDto, TaskDto } from '../types.js';

let kit: ProjectsKit;
beforeAll(async () => {
  kit = await createProjectsKit();
}, 120_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = PM, body, key }: Call) => {
  const response = await kit.app.inject({
    method,
    url,
    headers: {
      ...(await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return {
    status: response.statusCode,
    body: response.body === '' ? null : response.json<unknown>(),
  };
};
const errorCode = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

let keyCounter = 0;
const newKey = () => `prj-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const createBody = (over: Record<string, unknown> = {}) => ({
  name: 'Route boundary wall',
  partyId: kit.clientId,
  sector: 'private',
  originalContractValue: '500000',
  ...over,
});

const makeProject = async () => {
  const response = await call({
    method: 'POST',
    url: '/projects',
    body: createBody(),
    key: newKey(),
  });
  return response.body as ProjectDetailDto;
};

describe('GET and POST /projects', () => {
  it('creates a project and replays an idempotent retry', async () => {
    const key = newKey();
    const first = await call({ method: 'POST', url: '/projects', body: createBody(), key });
    const second = await call({ method: 'POST', url: '/projects', body: createBody(), key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect((first.body as ProjectDetailDto).status).toBe('planning');
  });

  it('refuses a bad body, a government project and users without the permission', async () => {
    const bad = await call({
      method: 'POST',
      url: '/projects',
      body: createBody({ partyId: 'x' }),
    });
    expect(bad.status).toBe(400);
    const gov = await call({
      method: 'POST',
      url: '/projects',
      body: createBody({ sector: 'government' }),
    });
    expect(errorCode(gov)).toBe('government_data_not_allowed');
    for (const user of [ACCOUNTANT, SUPERVISOR, NOBODY]) {
      expect(
        (await call({ method: 'POST', url: '/projects', user, body: createBody() })).status,
      ).toBe(403);
    }
    const key = await call({
      method: 'POST',
      url: '/projects',
      body: createBody(),
      key: '',
    });
    expect(errorCode(key)).toBe('invalid_idempotency_key');
  });

  it('lists projects for readers and filters them', async () => {
    const project = await makeProject();
    const list = await call({ method: 'GET', url: '/projects?status=planning&q=Route&limit=500' });
    expect(list.status).toBe(400);
    const ok = await call({ method: 'GET', url: '/projects?status=planning&q=Route&limit=100' });
    expect(ok.status).toBe(200);
    expect((ok.body as PageResult<ProjectDto>).items.some((p) => p.id === project.id)).toBe(true);
    expect((await call({ method: 'GET', url: '/projects', user: NOBODY })).status).toBe(403);
    expect((await call({ method: 'GET', url: '/projects', user: ACCOUNTANT })).status).toBe(200);
  });

  it('shows a supervisor only the projects assigned to them', async () => {
    const project = await makeProject();
    const other = await makeProject();
    const assign = await call({
      method: 'PUT',
      url: `/projects/${project.id}/supervisors`,
      body: { supervisors: [{ userId: SUPERVISOR }] },
    });
    expect(assign.status).toBe(200);
    const list = await call({ method: 'GET', url: '/projects', user: SUPERVISOR });
    expect((list.body as PageResult<ProjectDto>).items.map((p) => p.id)).toEqual([project.id]);
    expect(
      (await call({ method: 'GET', url: `/projects/${project.id}`, user: SUPERVISOR })).status,
    ).toBe(200);
    expect(
      (await call({ method: 'GET', url: `/projects/${other.id}`, user: SUPERVISOR })).status,
    ).toBe(404);
    // Supervisors can read the tasks of their project and manage them.
    const task = await call({
      method: 'POST',
      url: `/projects/${project.id}/tasks`,
      user: SUPERVISOR,
      body: { name: 'Site clearing' },
    });
    expect(task.status).toBe(201);
    expect(
      (
        await call({
          method: 'POST',
          url: `/projects/${other.id}/tasks`,
          user: SUPERVISOR,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(404);
    // But not edit the project or see its costs.
    expect(
      (
        await call({
          method: 'PATCH',
          url: `/projects/${project.id}`,
          user: SUPERVISOR,
          body: { name: 'x', version: 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call({ method: 'GET', url: `/projects/${project.id}/summary`, user: SUPERVISOR }))
        .status,
    ).toBe(403);
  });
});

describe('GET and PATCH /projects/:id', () => {
  it('returns one project, 404 for a missing one and 400 for a bad id', async () => {
    const project = await makeProject();
    const found = await call({ method: 'GET', url: `/projects/${project.id}` });
    expect(found.body).toMatchObject({ id: project.id, supervisors: [] });
    expect((await call({ method: 'GET', url: `/projects/${MISSING}` })).status).toBe(404);
    expect((await call({ method: 'GET', url: '/projects/not-a-uuid' })).status).toBe(400);
  });

  it('updates under the version, replays a retry and reports a conflict', async () => {
    const project = await makeProject();
    const key = newKey();
    const body = { name: 'Renamed by route', version: project.version };
    const first = await call({ method: 'PATCH', url: `/projects/${project.id}`, body, key });
    const again = await call({ method: 'PATCH', url: `/projects/${project.id}`, body, key });
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((first.body as ProjectDetailDto).name).toBe('Renamed by route');
    const stale = await call({
      method: 'PATCH',
      url: `/projects/${project.id}`,
      body: { ...body, name: 'z' },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    expect(
      (await call({ method: 'PATCH', url: `/projects/${project.id}`, body: { name: '' } })).status,
    ).toBe(400);
    expect(
      (await call({ method: 'PATCH', url: `/projects/${MISSING}`, body: { version: 1 } })).status,
    ).toBe(404);
    expect(
      (await call({ method: 'PATCH', url: `/projects/${project.id}`, user: ACCOUNTANT, body }))
        .status,
    ).toBe(403);
  });
});

describe('POST /projects/:id/status', () => {
  it('moves the status, refuses a bad move and a stale version', async () => {
    const project = await makeProject();
    const url = `/projects/${project.id}/status`;
    const key = newKey();
    const body = { status: 'active', version: project.version };
    const moved = await call({ method: 'POST', url, body, key });
    expect((moved.body as ProjectDetailDto).status).toBe('active');
    expect((await call({ method: 'POST', url, body, key })).body).toEqual(moved.body);
    const stale = await call({
      method: 'POST',
      url,
      body: { status: 'on_hold', version: project.version },
    });
    expect(errorCode(stale)).toBe('version_conflict');
    const bad = await call({
      method: 'POST',
      url,
      body: { status: 'closed', version: (moved.body as ProjectDetailDto).version },
    });
    expect(errorCode(bad)).toBe('project_transition');
    expect((await call({ method: 'POST', url, body: { status: 'nope', version: 1 } })).status).toBe(
      400,
    );
    expect((await call({ method: 'POST', url, user: ACCOUNTANT, body })).status).toBe(403);
    expect((await call({ method: 'POST', url: `/projects/${MISSING}/status`, body })).status).toBe(
      404,
    );
  });
});

describe('budget, summary and cost entries', () => {
  it('edits the budget, shows the summary and lists cost entries', async () => {
    const project = await makeProject();
    const url = `/projects/${project.id}/budget`;
    const lines = [{ costCodeId: kit.codes['100'], description: 'Bricks', budgetAmount: '1000' }];
    const key = newKey();
    const saved = await call({
      method: 'PUT',
      url,
      body: { version: project.version, lines },
      key,
    });
    expect(saved.status).toBe(200);
    expect(
      (await call({ method: 'PUT', url, body: { version: project.version, lines }, key })).body,
    ).toEqual(saved.body);
    expect(
      errorCode(await call({ method: 'PUT', url, body: { version: project.version, lines } })),
    ).toBe('version_conflict');
    expect((await call({ method: 'GET', url, user: ACCOUNTANT })).body).toMatchObject({
      lines: [{ description: 'Bricks', budgetAmount: '1000.00', source: 'manual' }],
    });
    expect(
      (await call({ method: 'PUT', url, body: { version: 1, lines: [{ costCodeId: 'x' }] } }))
        .status,
    ).toBe(400);
    expect(
      (await call({ method: 'PUT', url, user: ACCOUNTANT, body: { version: 1, lines } })).status,
    ).toBe(403);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/projects/${MISSING}/budget`,
          body: { version: 1, lines },
        })
      ).status,
    ).toBe(404);
    expect((await call({ method: 'GET', url: `/projects/${MISSING}/budget` })).status).toBe(404);

    await kit.cost(project.id, { amount: '300.00' });
    const summary = await call({
      method: 'GET',
      url: `/projects/${project.id}/summary`,
      user: ACCOUNTANT,
    });
    expect(summary.body).toMatchObject({
      totals: { committed: '300.00', approved: '0.00', posted: '0.00' },
      budget: '1000.00',
      variance: '700.00',
    });
    const entries = await call({
      method: 'GET',
      url: `/projects/${project.id}/cost-entries?status=committed&limit=5`,
      user: MANAGEMENT,
    });
    expect((entries.body as PageResult<unknown>).total).toBe(1);
    expect(
      (await call({ method: 'GET', url: `/projects/${project.id}/cost-entries?status=zzz` }))
        .status,
    ).toBe(400);
    expect((await call({ method: 'GET', url: `/projects/${MISSING}/summary` })).status).toBe(404);
    expect((await call({ method: 'GET', url: `/projects/${MISSING}/cost-entries` })).status).toBe(
      404,
    );
    expect(
      (await call({ method: 'GET', url: `/projects/${project.id}/cost-entries`, user: NOBODY }))
        .status,
    ).toBe(403);
  });
});

describe('tasks', () => {
  it('creates, lists and updates tasks', async () => {
    const project = await makeProject();
    const url = `/projects/${project.id}/tasks`;
    const key = newKey();
    const created = await call({
      method: 'POST',
      url,
      body: { name: 'Excavation', dueDate: '2026-11-10' },
      key,
    });
    expect(created.status).toBe(201);
    expect(
      (
        await call({
          method: 'POST',
          url,
          body: { name: 'Excavation', dueDate: '2026-11-10' },
          key,
        })
      ).body,
    ).toEqual(created.body);
    const task = created.body as TaskDto;
    const list = await call({ method: 'GET', url, user: ACCOUNTANT });
    expect((list.body as TaskDto[]).map((t) => t.id)).toEqual([task.id]);
    const updated = await call({
      method: 'PATCH',
      url: `${url}/${task.id}`,
      body: { status: 'done', version: task.version },
    });
    expect(updated.body).toMatchObject({ status: 'done', percentComplete: 100 });
    expect(
      errorCode(
        await call({ method: 'PATCH', url: `${url}/${task.id}`, body: { version: task.version } }),
      ),
    ).toBe('version_conflict');
    expect((await call({ method: 'POST', url, body: { name: '' } })).status).toBe(400);
    expect(
      (await call({ method: 'POST', url, user: ACCOUNTANT, body: { name: 'x' } })).status,
    ).toBe(403);
    expect(
      (await call({ method: 'PATCH', url: `${url}/${MISSING}`, body: { version: 1 } })).status,
    ).toBe(404);
    expect(
      (await call({ method: 'POST', url: `/projects/${MISSING}/tasks`, body: { name: 'x' } }))
        .status,
    ).toBe(404);
    expect((await call({ method: 'GET', url: `/projects/${MISSING}/tasks` })).status).toBe(404);
  });
});

describe('PUT /projects/:id/supervisors', () => {
  it('assigns and ends supervisors, refusing bad input', async () => {
    const project = await makeProject();
    const url = `/projects/${project.id}/supervisors`;
    const key = newKey();
    const body = { supervisors: [{ userId: SUPERVISOR, fromDate: '2026-10-20' }] };
    const saved = await call({ method: 'PUT', url, body, key });
    expect((saved.body as ProjectDetailDto).supervisors).toEqual([
      { userId: SUPERVISOR, fromDate: '2026-10-20', toDate: null },
    ]);
    expect((await call({ method: 'PUT', url, body, key })).body).toEqual(saved.body);
    const ended = await call({ method: 'PUT', url, body: { supervisors: [] } });
    expect((ended.body as ProjectDetailDto).supervisors[0]?.toDate).toBe('2026-10-25');
    expect(
      (await call({ method: 'PUT', url, body: { supervisors: [{ userId: 'x' }] } })).status,
    ).toBe(400);
    expect((await call({ method: 'PUT', url, user: ACCOUNTANT, body })).status).toBe(403);
    expect(
      (await call({ method: 'PUT', url: `/projects/${MISSING}/supervisors`, body })).status,
    ).toBe(404);
    expect(
      errorCode(await call({ method: 'PUT', url, body: { supervisors: [{ userId: uid(9777) }] } })),
    ).toBe('user_not_found');
  });
});
