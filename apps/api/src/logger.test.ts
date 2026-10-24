import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { REDACTED, createLogger, scrub, scrubString, serializers } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = { write: (chunk: string) => void lines.push(chunk) };
  return { lines, logger: createLogger('info', stream) };
}

describe('logger redaction (T-4)', () => {
  it('removes the authorization header and cookies', () => {
    const { lines, logger } = capture();
    logger.info({ headers: { authorization: 'Bearer abc.def', cookie: 'sid=1' } }, 'in');
    expect(lines.join('')).not.toContain('abc.def');
    expect(lines.join('')).not.toContain('sid=1');
    expect(lines.join('')).toContain(REDACTED);
  });

  it('removes CNIC numbers with and without dashes', () => {
    expect(scrubString('cnic 35202-1234567-1 and 3520212345671')).toBe(
      `cnic ${REDACTED} and ${REDACTED}`,
    );
  });

  it('removes Pakistani phone numbers in common formats', () => {
    expect(scrubString('call +92 300 1234567')).toBe(`call ${REDACTED}`);
    expect(scrubString('call 0300-1234567')).toBe(`call ${REDACTED}`);
    expect(scrubString('call 03001234567')).toBe(`call ${REDACTED}`);
  });

  it('scrubs strings in messages and nested objects and arrays', () => {
    const { lines, logger } = capture();
    logger.info(
      { worker: { cnic: '35202-1234567-1', phones: ['0300-1234567', 'x'] } },
      'phone 0300-1234567',
    );
    const output = lines.join('');
    expect(output).not.toContain('1234567');
    const parsed = JSON.parse(output) as { worker: { phones: string[] } };
    expect(parsed.worker.phones[1]).toBe('x');
  });

  it('leaves unrelated values, errors and very deep structures alone', () => {
    const error = new Error('boom');
    expect(scrub(42)).toBe(42);
    expect(scrub(null)).toBeNull();
    expect(scrub(error)).toBe(error);
    expect(scrub(['a', 1])).toEqual(['a', 1]);
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: '0300-1234567' } } } } } } } };
    expect(JSON.stringify(scrub(deep))).toContain('0300-1234567');
  });

  it('serialises requests without headers and scrubs the url', () => {
    expect(
      serializers.req({ method: 'GET', url: '/workers?phone=0300-1234567', ip: '10.0.0.1' }),
    ).toEqual({ method: 'GET', url: `/workers?phone=${REDACTED}`, ip: '10.0.0.1' });
    expect(serializers.res({ statusCode: 204 })).toEqual({ statusCode: 204 });
  });

  it('logs only method, url and status for real requests', async () => {
    const { lines, logger } = capture();
    const app = await buildApp({ config: { corsOrigins: [] }, logger });
    await app.inject({
      method: 'GET',
      url: '/health?cnic=35202-1234567-1',
      headers: { authorization: 'Bearer secret.token.value' },
    });
    await app.close();
    const output = lines.join('');
    expect(output).toContain('"method":"GET"');
    expect(output).toContain('/health?cnic=');
    expect(output).not.toContain('secret.token.value');
    expect(output).not.toContain('1234567');
  });
});
