import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedMasters, wallTemplate, type Fixture } from '../fixtures.js';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  createEstimationKit,
  type EstimationKit,
} from '../test-support.js';
import type {
  EstimateDto,
  EstimateSummaryDto,
  PageResult,
  TemplateDto,
  TemplateSummaryDto,
} from '../types.js';

let kit: EstimationKit;
let fixture: Fixture;
beforeAll(async () => {
  kit = await createEstimationKit();
  fixture = await seedMasters(kit);
}, 60_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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
const newKey = () => `est-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const templateBody = (code: string) => wallTemplate(kit, fixture, code);
const makeTemplate = async (code: string) => {
  const response = await call({
    method: 'POST',
    url: '/estimation/templates',
    body: templateBody(code),
    key: newKey(),
  });
  expect(response.status).toBe(201);
  return response.body as TemplateDto;
};

const estimateBody = (over: Record<string, unknown> = {}) => ({
  title: 'Route estimate',
  workType: 'boundary_wall',
  sector: 'private',
  lines: [
    {
      description: 'Bricks',
      lineKind: 'material',
      costCodeId: kit.costCodes.material,
      unitCode: 'nos',
      quantity: '100',
      rate: '20',
    },
  ],
  ...over,
});
const makeEstimate = async (over: Record<string, unknown> = {}) => {
  const response = await call({
    method: 'POST',
    url: '/estimation/estimates',
    body: estimateBody(over),
    key: newKey(),
  });
  expect(response.status).toBe(201);
  return response.body as EstimateDto;
};

describe('authorization (spec section 6)', () => {
  const requests: Omit<Call, 'user'>[] = [
    { method: 'GET', url: '/estimation/templates' },
    { method: 'GET', url: `/estimation/templates/${MISSING}` },
    { method: 'POST', url: '/estimation/templates', body: {} },
    { method: 'PUT', url: `/estimation/templates/${MISSING}`, body: {} },
    { method: 'DELETE', url: `/estimation/templates/${MISSING}?version=1` },
    { method: 'POST', url: `/estimation/templates/${MISSING}/copy`, body: {} },
    { method: 'POST', url: '/estimation/formula-preview', body: {} },
    { method: 'GET', url: '/estimation/estimates' },
    { method: 'GET', url: `/estimation/estimates/${MISSING}` },
    { method: 'GET', url: `/estimation/estimates/${MISSING}/summary` },
    { method: 'POST', url: '/estimation/estimates', body: {} },
    { method: 'POST', url: '/estimation/estimates/from-template', body: {} },
    { method: 'POST', url: '/estimation/estimates/preview', body: { lines: [] } },
    { method: 'PUT', url: `/estimation/estimates/${MISSING}`, body: {} },
    { method: 'DELETE', url: `/estimation/estimates/${MISSING}?version=1` },
    { method: 'POST', url: `/estimation/estimates/${MISSING}/lock`, body: { version: 1 } },
    { method: 'POST', url: `/estimation/estimates/${MISSING}/revise`, body: {} },
  ];
  const reads = new Set([
    'GET /estimation/templates',
    `GET /estimation/templates/${MISSING}`,
    'GET /estimation/estimates',
    `GET /estimation/estimates/${MISSING}`,
    `GET /estimation/estimates/${MISSING}/summary`,
    'POST /estimation/estimates/preview',
  ]);

  it('denies supervisors and users without permissions everywhere', async () => {
    for (const request of requests) {
      for (const user of [SUPERVISOR, NOBODY]) {
        const response = await call({ ...request, user });
        expect(response.status, `${request.method} ${request.url} as ${user}`).toBe(403);
      }
    }
  });

  it('lets the accountant read but not change', async () => {
    for (const request of requests) {
      const response = await call({ ...request, user: ACCOUNTANT });
      if (reads.has(`${request.method} ${request.url}`)) {
        expect(response.status, request.url).not.toBe(403);
      } else {
        expect(response.status, `${request.method} ${request.url}`).toBe(403);
      }
    }
  });

  it('requires a signed-in user', async () => {
    const response = await kit.app.inject({ method: 'GET', url: '/estimation/estimates' });
    expect(response.statusCode).toBe(401);
  });
});

describe('templates', () => {
  it('creates, reads, lists, updates, copies and deletes a template', async () => {
    const template = await makeTemplate('R-WALL');
    expect(template.lines).toHaveLength(3);
    const read = await call({ method: 'GET', url: `/estimation/templates/${template.id}` });
    expect(read.body).toEqual(template);

    const list = await call({
      method: 'GET',
      url: '/estimation/templates?q=r-wall&active=true&workType=boundary_wall',
    });
    expect((list.body as PageResult<TemplateSummaryDto>).items.map((t) => t.code)).toEqual([
      'R-WALL',
    ]);

    const update = await call({
      method: 'PUT',
      url: `/estimation/templates/${template.id}`,
      body: { ...templateBody('R-WALL'), name: 'Renamed', version: template.version },
      user: MANAGEMENT,
    });
    expect(update.status).toBe(200);
    expect((update.body as TemplateDto).name).toBe('Renamed');

    const copy = await call({
      method: 'POST',
      url: `/estimation/templates/${template.id}/copy`,
      body: { code: 'R-WALL-2', name: 'Copy' },
      key: newKey(),
    });
    expect(copy.status).toBe(201);
    expect((copy.body as TemplateDto).lines).toHaveLength(3);

    const remove = await call({
      method: 'DELETE',
      url: `/estimation/templates/${template.id}?version=${(update.body as TemplateDto).version}`,
      key: newKey(),
    });
    expect(remove.status).toBe(204);
    expect(
      (await call({ method: 'GET', url: `/estimation/templates/${template.id}` })).status,
    ).toBe(404);
  });

  it('answers 400 for malformed input and for an injected formula', async () => {
    for (const body of [
      {},
      { ...templateBody('X1'), workType: 'castle' },
      { ...templateBody('X2'), lines: [{ description: 'x' }] },
      { ...templateBody('X3'), parameters: [{ key: 'a' }] },
    ]) {
      const response = await call({ method: 'POST', url: '/estimation/templates', body });
      expect(response.status).toBe(400);
    }
    expect((await call({ method: 'GET', url: '/estimation/templates?limit=0' })).status).toBe(400);
    expect((await call({ method: 'GET', url: '/estimation/templates/not-a-uuid' })).status).toBe(
      400,
    );
    const badFormula = templateBody('X4');
    (badFormula.lines[0] as { qtyFormula: string }).qtyFormula = 'process.exit(1)';
    const response = await call({ method: 'POST', url: '/estimation/templates', body: badFormula });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('formula_invalid_character');
  });

  it('answers 404, 409 and replays an idempotent create', async () => {
    expect((await call({ method: 'GET', url: `/estimation/templates/${MISSING}` })).status).toBe(
      404,
    );
    expect(
      (
        await call({
          method: 'PUT',
          url: `/estimation/templates/${MISSING}`,
          body: { ...templateBody('GONE'), version: 1 },
        })
      ).status,
    ).toBe(404);

    const template = await makeTemplate('R-409');
    const stale = await call({
      method: 'PUT',
      url: `/estimation/templates/${template.id}`,
      body: { ...templateBody('R-409'), version: template.version + 4 },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    expect(
      (await call({ method: 'DELETE', url: `/estimation/templates/${template.id}?version=9` }))
        .status,
    ).toBe(409);
    const duplicate = await call({
      method: 'POST',
      url: '/estimation/templates',
      body: templateBody('R-409'),
    });
    expect(duplicate.status).toBe(409);

    const key = newKey();
    const first = await call({
      method: 'POST',
      url: '/estimation/templates',
      body: templateBody('R-IDEM'),
      key,
    });
    const replay = await call({
      method: 'POST',
      url: '/estimation/templates',
      body: templateBody('R-IDEM'),
      key,
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect((replay.body as TemplateDto).id).toBe((first.body as TemplateDto).id);
    const changed = await call({
      method: 'POST',
      url: '/estimation/templates',
      body: templateBody('R-IDEM-2'),
      key,
    });
    expect(changed.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a malformed Idempotency-Key header', async () => {
    const response = await kit.app.inject({
      method: 'POST',
      url: '/estimation/templates',
      headers: { ...(await kit.auth(PM)), 'idempotency-key': '' },
      payload: templateBody('R-KEY'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('previews formulas for sample values (T-7)', async () => {
    const response = await call({
      method: 'POST',
      url: '/estimation/formula-preview',
      body: {
        parameters: [{ key: 'length', label: 'Length', unit: 'ft' }],
        values: { length: '12' },
        formulas: ['length * 2', 'length / 0', 'eval(1)'],
      },
    });
    expect(response.status).toBe(200);
    expect(
      (
        response.body as {
          results: { ok: boolean; quantity: string | null; errorCode: string | null }[];
        }
      ).results.map((r) => [r.ok, r.quantity, r.errorCode]),
    ).toEqual([
      [true, '24.0000', null],
      [false, null, 'formula_division_by_zero'],
      [false, null, 'formula_unknown_function'],
    ]);
    expect(
      (await call({ method: 'POST', url: '/estimation/formula-preview', body: { formulas: [] } }))
        .status,
    ).toBe(400);
  });
});

describe('estimates', () => {
  it('creates from a template, edits, summarises, locks and revises (AC-1, AC-3)', async () => {
    const template = await makeTemplate('R-FLOW');
    const created = await call({
      method: 'POST',
      url: '/estimation/estimates/from-template',
      body: {
        templateId: template.id,
        title: 'Flow',
        sector: 'private',
        partyId: fixture.partyId,
        parameterValues: { length: '100', height: '6' },
        proposedPrice: '500000',
      },
      key: newKey(),
    });
    expect(created.status).toBe(201);
    const draft = created.body as EstimateDto;
    expect(draft.lines.map((l) => l.quantity)).toEqual(['8100.0000', '120.0000', '12.0000']);

    const blocked = await call({
      method: 'POST',
      url: `/estimation/estimates/${draft.id}/lock`,
      body: { version: draft.version },
    });
    expect(blocked.status).toBe(422);
    expect(errorCode(blocked)).toBe('rate_missing');

    const priced = await call({
      method: 'PUT',
      url: `/estimation/estimates/${draft.id}`,
      body: {
        ...estimateBody({ title: 'Flow', proposedPrice: '500000', partyId: fixture.partyId }),
        lines: draft.lines.map((l) => ({
          description: l.description,
          lineKind: l.lineKind,
          costCodeId: l.costCodeId,
          unitCode: l.unitCode,
          itemId: l.itemId,
          quantity: l.quantity,
          rate: l.rateMissing ? '2500' : l.rate,
        })),
        version: draft.version,
      },
    });
    expect(priced.status).toBe(200);

    const summary = await call({ method: 'GET', url: `/estimation/estimates/${draft.id}/summary` });
    expect((summary.body as EstimateSummaryDto).totals).toMatchObject({
      companyCost: '342000.00',
      totalCost: '393300.00',
      expectedMargin: '106700.00',
    });

    const locked = await call({
      method: 'POST',
      url: `/estimation/estimates/${draft.id}/lock`,
      body: { version: (priced.body as EstimateDto).version },
      key: newKey(),
    });
    expect(locked.status).toBe(200);
    expect((locked.body as EstimateDto).status).toBe('locked');

    const readOnly = await call({
      method: 'PUT',
      url: `/estimation/estimates/${draft.id}`,
      body: { ...estimateBody(), version: (locked.body as EstimateDto).version },
    });
    expect(readOnly.status).toBe(422);
    expect(errorCode(readOnly)).toBe('estimate_locked');

    const revise = await call({
      method: 'POST',
      url: `/estimation/estimates/${draft.id}/revise`,
      key: newKey(),
    });
    expect(revise.status).toBe(201);
    const revision = revise.body as EstimateDto;
    expect(revision).toMatchObject({ revision: 2, parentEstimateId: draft.id, status: 'draft' });
    expect(
      (await call({ method: 'POST', url: `/estimation/estimates/${draft.id}/revise` })).status,
    ).toBe(409);

    const lockedRevision = await call({
      method: 'POST',
      url: `/estimation/estimates/${revision.id}/lock`,
      body: { version: revision.version },
      user: MANAGEMENT,
    });
    expect(lockedRevision.status).toBe(200);
    const old = await call({ method: 'GET', url: `/estimation/estimates/${draft.id}` });
    expect((old.body as EstimateDto).status).toBe('superseded');
  });

  it('lists and filters estimates', async () => {
    const mine = await makeEstimate({ title: 'Listable one', leadId: MISSING });
    const list = await call({
      method: 'GET',
      url: `/estimation/estimates?q=listable&status=draft&leadId=${MISSING}`,
    });
    expect((list.body as PageResult<EstimateDto>).items.map((e) => e.id)).toContain(mine.id);
    expect((await call({ method: 'GET', url: '/estimation/estimates?status=weird' })).status).toBe(
      400,
    );
  });

  it('previews totals for unsaved lines', async () => {
    const response = await call({
      method: 'POST',
      url: '/estimation/estimates/preview',
      body: {
        proposedPrice: '1000',
        lines: [
          { lineKind: 'material', quantity: '10', rate: '50' },
          { lineKind: 'labour', quantity: '1', rate: '0' },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      rateMissingCount: 1,
      totals: { companyCost: '500.00', totalCost: '575.00', expectedMargin: '425.00' },
    });
    expect(
      (
        await call({
          method: 'POST',
          url: '/estimation/estimates/preview',
          body: { lines: [{ lineKind: 'x' }] },
        })
      ).status,
    ).toBe(400);
  });

  it('answers 400 for malformed input and 404 for missing records', async () => {
    for (const body of [
      {},
      estimateBody({ sector: 'alien' }),
      estimateBody({ proposedPrice: '12.345' }),
      estimateBody({ overheadPercent: 'ten' }),
      estimateBody({ lines: [{ description: 'x' }] }),
    ]) {
      expect((await call({ method: 'POST', url: '/estimation/estimates', body })).status).toBe(400);
    }
    expect(
      (
        await call({
          method: 'POST',
          url: '/estimation/estimates/from-template',
          body: { templateId: 'x' },
        })
      ).status,
    ).toBe(400);
    expect((await call({ method: 'GET', url: `/estimation/estimates/${MISSING}` })).status).toBe(
      404,
    );
    expect(
      (await call({ method: 'GET', url: `/estimation/estimates/${MISSING}/summary` })).status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'POST',
          url: '/estimation/estimates/from-template',
          body: { templateId: MISSING, title: 'x', sector: 'private', parameterValues: {} },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'POST', url: `/estimation/estimates/${MISSING}/revise` })).status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'POST',
          url: `/estimation/estimates/${MISSING}/lock`,
          body: { version: 1 },
        })
      ).status,
    ).toBe(404);
  });

  it('answers 409 on a version conflict and replays an idempotent create', async () => {
    const estimate = await makeEstimate();
    const stale = await call({
      method: 'PUT',
      url: `/estimation/estimates/${estimate.id}`,
      body: { ...estimateBody(), version: estimate.version + 3 },
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await call({
          method: 'POST',
          url: `/estimation/estimates/${estimate.id}/lock`,
          body: { version: 9 },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/estimation/estimates/${estimate.id}?version=9` }))
        .status,
    ).toBe(409);

    const key = newKey();
    const first = await call({
      method: 'POST',
      url: '/estimation/estimates',
      body: estimateBody(),
      key,
    });
    const replay = await call({
      method: 'POST',
      url: '/estimation/estimates',
      body: estimateBody(),
      key,
    });
    expect((replay.body as EstimateDto).id).toBe((first.body as EstimateDto).id);

    const remove = await call({
      method: 'DELETE',
      url: `/estimation/estimates/${estimate.id}?version=${estimate.version}`,
      key: newKey(),
    });
    expect(remove.status).toBe(204);
    expect(
      (await call({ method: 'GET', url: `/estimation/estimates/${estimate.id}` })).status,
    ).toBe(404);
  });
});
