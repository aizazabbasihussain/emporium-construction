import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runTaxPack, taxSignedOff, type TaxSample } from './tax-pack.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/cutover');
const pack = JSON.parse(readFileSync(path.join(DOCS, 'tax-samples.json'), 'utf8')) as {
  samples: TaxSample[];
};

describe('Gate B tax test pack runner (P2-10 T-4, BR-4)', () => {
  it('holds at least 10 sample documents', () => {
    expect(pack.samples.length).toBeGreaterThanOrEqual(10);
  });

  it('matches the expected tax and withholding of every sample', () => {
    const failed = runTaxPack(pack.samples).filter((result) => !result.ok);
    expect(failed).toEqual([]);
  });

  it('reports each difference when an expected figure is wrong', () => {
    const [first] = pack.samples as [TaxSample];
    const results = runTaxPack([
      { ...first, expected: { ...first.expected, tax: '1.00', withholding: '5.00' } },
    ]);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.differences).toEqual([
      expect.stringContaining('tax: expected 1.00'),
      expect.stringContaining('withholding: expected 5.00, engine gave nothing'),
    ]);
  });

  it('reads the sign-off: signed only when a name replaces the placeholder', () => {
    expect(taxSignedOff('| Signed by | Not signed yet |')).toBe(false);
    expect(taxSignedOff('| Signed by | A. Accountant, 2026-12-01 |')).toBe(true);
    expect(taxSignedOff('no table here')).toBe(false);
  });
});
