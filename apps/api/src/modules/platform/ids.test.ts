import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids.js';

describe('uuidv7', () => {
  it('has version 7, RFC variant and embeds the timestamp', () => {
    const id = uuidv7(new Date('2026-10-24T10:00:00Z'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(new Date(ms).toISOString()).toBe('2026-10-24T10:00:00.000Z');
  });

  it('is deterministic for fixed random bytes and sortable by time', () => {
    const bytes = new Uint8Array(10).fill(0xff);
    expect(uuidv7(new Date(1), bytes)).toBe(uuidv7(new Date(1), bytes));
    expect(uuidv7(new Date(1), bytes) < uuidv7(new Date(2), bytes)).toBe(true);
  });
});
