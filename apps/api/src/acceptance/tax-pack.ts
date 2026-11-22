import {
  calculateSalesTax,
  calculateWithholding,
  type RoundingMode,
  type TaxRateRule,
  type WithholdingRuleRef,
} from '@emporium/domain/tax';

/**
 * One sample document of the tax test pack (P2-10 BR-4): the accountant states the lines, the rules
 * and the tax and withholding they expect. `docs/cutover/tax-samples.json` holds the pack.
 */
export interface TaxSample {
  id: string;
  description: string;
  roundingMode: RoundingMode;
  pricesIncludeTax: boolean;
  lines: { id: string; amount: string; rule: TaxRateRule }[];
  withholding?: { rule: WithholdingRuleRef };
  expected: { base: string; tax: string; total: string; withholding?: string };
}

export interface TaxSampleResult {
  id: string;
  ok: boolean;
  differences: string[];
}

/** Runs every sample through the engine and lists each difference (empty `differences` means a match). */
export function runTaxPack(samples: readonly TaxSample[]): TaxSampleResult[] {
  return samples.map((sample) => {
    const result = calculateSalesTax(sample.lines, {
      roundingMode: sample.roundingMode,
      pricesIncludeTax: sample.pricesIncludeTax,
    });
    const actual: Record<string, string> = {
      base: result.base,
      tax: result.taxTotal,
      total: result.total,
    };
    if (sample.withholding !== undefined) {
      actual.withholding = calculateWithholding(sample.withholding.rule, {
        invoiceTotal: result.total,
        taxAmount: result.taxTotal,
        base: result.base,
      }).amount;
    }
    const differences = Object.entries(sample.expected)
      .filter(([key, value]) => actual[key] !== value)
      .map(([key, value]) => `${key}: expected ${value}, engine gave ${actual[key] ?? 'nothing'}`);
    return { id: sample.id, ok: differences.length === 0, differences };
  });
}

/** True when the sign-off document records a named accountant and a date (the template says "Not signed"). */
export function taxSignedOff(markdown: string): boolean {
  const row = markdown.split('\n').find((line) => /^\|\s*Signed by\s*\|/i.test(line));
  return row !== undefined && !/not signed/i.test(row);
}
