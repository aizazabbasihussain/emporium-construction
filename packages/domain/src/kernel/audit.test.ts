import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './audit.js';

describe('redactSecrets (BR-8)', () => {
  it('replaces secret-looking keys at any depth', () => {
    const input = {
      name: 'x',
      password: 'p',
      nested: { apiKey: 'k', token: 't', list: [{ CNIC: '1' }, 2] },
      when: new Date('2026-01-01T00:00:00Z'),
      nothing: null,
    };
    expect(redactSecrets(input)).toEqual({
      name: 'x',
      password: REDACTED,
      nested: { apiKey: REDACTED, token: REDACTED, list: [{ CNIC: REDACTED }, 2] },
      when: '2026-01-01T00:00:00.000Z',
      nothing: null,
    });
  });

  it('passes primitives through', () => {
    expect(redactSecrets('a')).toBe('a');
    expect(redactSecrets(undefined)).toBeUndefined();
  });
});
