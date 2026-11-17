/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- response bodies are read loosely in contract tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  createTaxKit,
  FROM,
  MANAGEMENT,
  NOBODY,
  STOREKEEPER,
  TEST_SALES,
  uid,
  type TaxKit,
} from '../test-support.js';

let kit: TaxKit;
beforeAll(async () => {
  kit = await createTaxKit();
}, 60_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = ACCOUNTANT, body, key }: Call) => {
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
    body: (response.body === '' ? null : response.json()) as Record<string, any>,
  };
};
const errorCode = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

const salesBody = { ...TEST_SALES, nature: 'route' };

describe('GET /tax/rules', () => {
  it('lists rules, authorities, the region map and the settings for anyone with rule.read', async () => {
    for (const user of [ACCOUNTANT, MANAGEMENT, ADMIN]) {
      const response = await call({ method: 'GET', url: '/tax/rules', user });
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
      expect(response.body.authorities.map((a: { code: string }) => a.code)).toEqual([
        'FBR',
        'PRA',
      ]);
      expect(response.body.regionMap).toEqual([]);
      expect(response.body.settings).toEqual({
        roundingMode: 'per_document',
        pricesIncludeTax: false,
      });
    }
  });

  it('filters by status and rejects an unknown status', async () => {
    expect((await call({ method: 'GET', url: '/tax/rules?status=active' })).body.items).toEqual([]);
    expect((await call({ method: 'GET', url: '/tax/rules?status=bogus' })).status).toBe(400);
  });

  it('denies roles without the permission', async () => {
    for (const user of [STOREKEEPER, NOBODY]) {
      expect((await call({ method: 'GET', url: '/tax/rules', user })).status).toBe(403);
    }
  });
});

describe('POST /tax/rules', () => {
  it('records a pending rule for the accountant', async () => {
    const response = await call({ method: 'POST', url: '/tax/rules', body: salesBody });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'pending_approval',
      ratePercent: '10.0000',
      requestedBy: ACCOUNTANT,
    });
    const listed = await call({ method: 'GET', url: '/tax/rules?status=pending_approval' });
    expect(listed.body.items).toHaveLength(1);
  });

  it('replays the first response for the same idempotency key, and creates one rule', async () => {
    const body = { ...salesBody, nature: 'idem' };
    const key = kit.key();
    const first = await call({ method: 'POST', url: '/tax/rules', body, key });
    const second = await call({ method: 'POST', url: '/tax/rules', body, key });
    expect(second).toEqual(first);
    const pending = await call({ method: 'GET', url: '/tax/rules?status=pending_approval' });
    expect(pending.body.items.filter((r: { nature: string }) => r.nature === 'idem')).toHaveLength(
      1,
    );
  });

  it('fails validation for a bad body', async () => {
    for (const body of [
      {},
      { ...salesBody, ratePercent: 'ten' },
      { ...salesBody, ratePercent: '1.23456' },
      { ...salesBody, supplyKind: 'barter' },
      { ...salesBody, effectiveFrom: 'yesterday' },
    ]) {
      const response = await call({ method: 'POST', url: '/tax/rules', body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers a rule that breaks a business rule with its code', async () => {
    const post = (body: unknown) => call({ method: 'POST', url: '/tax/rules', body });
    expect(errorCode(await post({ ...salesBody, authorityCode: 'NOPE' }))).toBe(
      'tax_authority_unknown',
    );
    expect(errorCode(await post({ ...salesBody, ratePercent: '101' }))).toBe(
      'tax_rate_out_of_range',
    );
    await kit.approveSales({ ...TEST_SALES, nature: 'taken' });
    expect(errorCode(await post({ ...TEST_SALES, nature: 'taken' }))).toBe('tax_rule_overlap');
  });

  it('rejects an invalid idempotency key header', async () => {
    const response = await call({ method: 'POST', url: '/tax/rules', body: salesBody, key: '' });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('invalid_idempotency_key');
  });

  it('denies everyone but the accountant (tax.rule.manage)', async () => {
    for (const user of [ADMIN, MANAGEMENT, STOREKEEPER, NOBODY]) {
      expect(
        (await call({ method: 'POST', url: '/tax/rules', user, body: salesBody })).status,
      ).toBe(403);
    }
  });
});

describe('POST /tax/region-map', () => {
  const body = {
    region: 'islamabad',
    supplyKind: 'services',
    authorityCode: 'FBR',
    effectiveFrom: FROM,
  };

  it('records a pending mapping, rejects a bad one and denies others', async () => {
    const created = await call({ method: 'POST', url: '/tax/region-map', body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ region: 'islamabad', status: 'pending_approval' });
    expect(
      (await call({ method: 'POST', url: '/tax/region-map', body: { ...body, region: 'sindh' } }))
        .status,
    ).toBe(400);
    expect(
      (await call({ method: 'POST', url: '/tax/region-map', user: MANAGEMENT, body })).status,
    ).toBe(403);
    const listed = await call({ method: 'GET', url: '/tax/rules?status=pending_approval' });
    expect(listed.body.regionMap).toHaveLength(1);
  });
});

describe('withholding rules', () => {
  const body = {
    direction: 'we_withhold',
    authorityCode: 'FBR',
    nature: 'civil',
    ratePercent: '2',
    base: 'on_base',
    effectiveFrom: FROM,
  };

  it('lists, records, validates and denies', async () => {
    expect((await call({ method: 'GET', url: '/tax/withholding-rules' })).body.items).toEqual([]);
    const created = await call({ method: 'POST', url: '/tax/withholding-rules', body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      direction: 'we_withhold',
      base: 'on_base',
      partyType: null,
    });
    const listed = await call({
      method: 'GET',
      url: '/tax/withholding-rules?status=pending_approval',
    });
    expect(listed.body.items).toHaveLength(1);
    expect(
      (
        await call({
          method: 'POST',
          url: '/tax/withholding-rules',
          body: { ...body, base: 'on_hope' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call({ method: 'POST', url: '/tax/withholding-rules', user: STOREKEEPER, body }))
        .status,
    ).toBe(403);
    expect(
      (await call({ method: 'GET', url: '/tax/withholding-rules', user: NOBODY })).status,
    ).toBe(403);
    const key = kit.key();
    const again = { ...body, nature: 'idem' };
    const first = await call({ method: 'POST', url: '/tax/withholding-rules', body: again, key });
    expect(await call({ method: 'POST', url: '/tax/withholding-rules', body: again, key })).toEqual(
      first,
    );
  });
});

describe('POST /tax/calculate', () => {
  const body = {
    locationId: '',
    supplyKind: 'services',
    date: '2026-06-15',
    lines: [{ id: 'l1', amount: '1000.00' }],
  };

  it('refuses while nothing is configured, naming what is missing, and 404s an unknown location', async () => {
    const refused = await call({
      method: 'POST',
      url: '/tax/calculate',
      body: { ...body, locationId: kit.islamabadId },
    });
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe('tax_authority_unmapped');
    const unknown = await call({
      method: 'POST',
      url: '/tax/calculate',
      body: { ...body, locationId: uid(9999) },
    });
    expect(unknown.status).toBe(404);
  });

  it('previews tax once a mapping and a rule are approved', async () => {
    await kit.approveRegion({
      region: 'islamabad',
      supplyKind: 'services',
      authorityCode: 'FBR',
      effectiveFrom: FROM,
    });
    await kit.approveSales({ ...TEST_SALES, nature: 'preview' });
    await kit.approveSales({ ...TEST_SALES, taxCode: 'GENERAL' });
    const ok = await call({
      method: 'POST',
      url: '/tax/calculate',
      body: { ...body, locationId: kit.islamabadId },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      authorityCode: 'FBR',
      base: '1000.00',
      taxTotal: '100.00',
      total: '1100.00',
    });
  });

  it('validates the body and the permission', async () => {
    expect((await call({ method: 'POST', url: '/tax/calculate', body: {} })).status).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/tax/calculate',
          body: { ...body, locationId: kit.islamabadId, lines: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/tax/calculate',
          user: NOBODY,
          body: { ...body, locationId: kit.islamabadId },
        })
      ).status,
    ).toBe(403);
  });
});

describe('GET /tax/reports', () => {
  it('returns the aggregate for an authority and month', async () => {
    const response = await call({
      method: 'GET',
      url: '/tax/reports?authority=FBR&month=2026-10',
      user: MANAGEMENT,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      authorityCode: 'FBR',
      month: '2026-10',
      outputTax: { base: '0.00', documents: 0 },
    });
  });

  it('validates the query, answers an unknown authority and denies others', async () => {
    expect((await call({ method: 'GET', url: '/tax/reports?authority=FBR' })).status).toBe(400);
    expect(
      (await call({ method: 'GET', url: '/tax/reports?authority=FBR&month=2026-13' })).status,
    ).toBe(400);
    expect(
      (await call({ method: 'GET', url: '/tax/reports?authority=NOPE&month=2026-10' })).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'GET',
          url: '/tax/reports?authority=FBR&month=2026-10',
          user: STOREKEEPER,
        })
      ).status,
    ).toBe(403);
  });
});

describe('unauthenticated access', () => {
  it('needs a token on every tax route', async () => {
    for (const [method, url] of [
      ['GET', '/tax/rules'],
      ['POST', '/tax/rules'],
      ['GET', '/tax/withholding-rules'],
      ['POST', '/tax/calculate'],
      ['GET', '/tax/reports?authority=FBR&month=2026-10'],
    ] as const) {
      expect((await kit.app.inject({ method, url })).statusCode, url).toBe(401);
    }
  });
});
