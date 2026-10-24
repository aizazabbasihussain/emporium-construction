const SECRET_KEY = /password|secret|token|authorization|api[_-]?key|cnic|phone/i;

export const REDACTED = '[redacted]';

/** Copy of `value` with the content of secret-looking keys replaced, so audit rows never hold secrets (BR-8). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SECRET_KEY.test(key) ? REDACTED : redactSecrets(inner),
      ]),
    );
  }
  return value;
}
