import { describe, expect, it } from 'vitest';
import { pageOf, requiredText, textOrNull } from './support.js';

describe('estimation service support', () => {
  it('turns empty text into null and trims the rest', () => {
    expect(textOrNull(undefined)).toBeNull();
    expect(textOrNull(null)).toBeNull();
    expect(textOrNull('   ')).toBeNull();
    expect(textOrNull(' a b ')).toBe('a b');
  });

  it('requires text', () => {
    expect(requiredText(' x ', 'name')).toBe('x');
    expect(() => requiredText('', 'name')).toThrow(
      expect.objectContaining({ code: 'name_required' }),
    );
  });

  it('wraps a page', () => {
    expect(pageOf([1], 5, { limit: 1, offset: 2 })).toEqual({
      items: [1],
      total: 5,
      limit: 1,
      offset: 2,
    });
  });
});
