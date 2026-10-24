import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RuleViolationError,
  UnauthorizedError,
  ValidationError,
} from '@emporium/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import type { ErrorBody } from './errors.js';
import { createLogger } from './logger.js';

let app: FastifyInstance;
const fixedNow = new Date('2026-10-24T10:00:00.000Z');

beforeAll(async () => {
  app = await buildApp({
    config: { corsOrigins: ['http://localhost:5173'] },
    logger: createLogger('silent'),
    clock: () => fixedNow,
  });
  app.get('/t/validation', async () => {
    throw new ValidationError('bad_input', 'Bad input', { field: 'name' });
  });
  app.get('/t/unauthorized', async () => {
    throw new UnauthorizedError();
  });
  app.get('/t/forbidden', async () => {
    throw new ForbiddenError();
  });
  app.get('/t/not-found', async () => {
    throw new NotFoundError();
  });
  app.get('/t/conflict', async () => {
    throw new ConflictError('stale', 'Version mismatch');
  });
  app.get('/t/rule', async () => {
    throw new RuleViolationError('rule', 'Rule broken');
  });
  app.get('/t/zod', async () => z.object({ name: z.string() }).parse({}));
  app.get('/t/boom', async () => {
    throw new Error('database password is hunter2');
  });
  app.post('/t/json', async (request) => request.body);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('health endpoint (T-8)', () => {
  it('returns status, version and time', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; version: string; time: string }>();
    expect(body).toEqual({ status: 'ok', version: body.version, time: '2026-10-24T10:00:00.000Z' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('defaults the clock to the real time', async () => {
    const real = await buildApp({
      config: { corsOrigins: [] },
      logger: createLogger('silent'),
    });
    const response = await real.inject({ method: 'GET', url: '/health' });
    expect(Math.abs(Date.parse(response.json<{ time: string }>().time) - Date.now())).toBeLessThan(
      60_000,
    );
    await real.close();
  });
});

describe('request id and CORS', () => {
  it('generates a request id and returns it in a header', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours an incoming request id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(response.headers['x-request-id']).toBe('abc-123');
  });

  it('allows configured origins only', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.test' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('central error handler (T-3)', () => {
  it.each([
    ['/t/validation', 400, 'bad_input'],
    ['/t/unauthorized', 401, 'unauthorized'],
    ['/t/forbidden', 403, 'forbidden'],
    ['/t/not-found', 404, 'not_found'],
    ['/t/conflict', 409, 'stale'],
    ['/t/rule', 422, 'rule'],
    ['/t/zod', 400, 'validation_failed'],
  ])('maps %s to %i', async (url, status, code) => {
    const response = await app.inject({ method: 'GET', url });
    const body = response.json<ErrorBody>();
    expect(response.statusCode).toBe(status);
    expect(body.error.code).toBe(code);
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('includes details for validation errors', async () => {
    const response = await app.inject({ method: 'GET', url: '/t/validation' });
    expect(response.json<ErrorBody>().error.details).toEqual({ field: 'name' });
  });

  it('returns 500 without leaking details for unknown errors', async () => {
    const response = await app.inject({ method: 'GET', url: '/t/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
    expect(response.json<ErrorBody>().error).toMatchObject({
      code: 'internal_error',
      message: 'Internal server error',
    });
    expect(response.json<ErrorBody>().error.details).toBeUndefined();
  });

  it('returns 404 in the standard shape for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('not_found');
  });

  it('maps framework client errors such as malformed JSON to 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/t/json',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('request_error');
  });
});
