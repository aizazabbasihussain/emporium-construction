import { Money, Percent, UnroundedMoney, roundMoney } from '../kernel/money.js';

// Sales tax and withholding arithmetic (spec P2-01 BR-3 and BR-4). Pure: the caller resolves the
// rule of each line first. Everything is exact decimal; rounding is half-up to 2 decimals.

export interface TaxRateRule {
  id: string;
  authorityCode: string;
  taxCode: string;
  ratePercent: string;
}

export interface TaxLineInput {
  id: string;
  /** Net amount with exclusive prices, gross amount when prices include tax. */
  amount: string;
  rule: TaxRateRule;
}

export type RoundingMode = 'per_line' | 'per_document';

export interface TaxLineResult {
  id: string;
  ruleId: string;
  /** Null where the mode does not allocate a figure to the line (per document). */
  base: string | null;
  tax: string | null;
}

export interface TaxGroup {
  authorityCode: string;
  taxCode: string;
  ratePercent: string;
  ruleIds: string[];
  base: string;
  tax: string;
}

/** The value object handed to documents; it states every rule and rate used (BR-7). */
export interface TaxResult {
  roundingMode: RoundingMode;
  pricesIncludeTax: boolean;
  base: string;
  taxTotal: string;
  total: string;
  taxLines: TaxGroup[];
  lines: TaxLineResult[];
}

const hundred = (rate: Percent) => rate.value.div(100);

/** Net and tax of one gross amount: net = gross / (1 + rate), tax = gross - net. */
function splitGross(gross: Money, rate: Percent): { base: Money; tax: Money } {
  const base = roundMoney(new UnroundedMoney(gross.value.div(hundred(rate).plus(1))));
  return { base, tax: gross.sub(base) };
}

const taxOf = (base: Money, rate: Percent): Money => roundMoney(base.percent(rate));

interface Figures {
  base: Money;
  tax: Money;
}

export function calculateSalesTax(
  lines: readonly TaxLineInput[],
  options: { roundingMode: RoundingMode; pricesIncludeTax: boolean },
): TaxResult {
  const { roundingMode, pricesIncludeTax } = options;
  const perLine = roundingMode === 'per_line';
  const groups = new Map<
    string,
    {
      rule: TaxRateRule;
      rate: Percent;
      ruleIds: Set<string>;
      amount: Money;
      base: Money;
      tax: Money;
    }
  >();
  const results: TaxLineResult[] = [];

  for (const line of lines) {
    const amount = Money.of(line.amount);
    const rate = Percent.of(line.rule.ratePercent);
    const key = `${line.rule.authorityCode}|${rate.toString()}|${line.rule.taxCode}`;
    const group = groups.get(key) ?? {
      rule: line.rule,
      rate,
      ruleIds: new Set<string>(),
      amount: Money.zero(),
      base: Money.zero(),
      tax: Money.zero(),
    };
    group.ruleIds.add(line.rule.id);
    group.amount = group.amount.add(amount);
    let figures: Figures | null = null;
    if (perLine) {
      figures = pricesIncludeTax
        ? splitGross(amount, rate)
        : { base: amount, tax: taxOf(amount, rate) };
      group.base = group.base.add(figures.base);
      group.tax = group.tax.add(figures.tax);
    }
    groups.set(key, group);
    results.push({
      id: line.id,
      ruleId: line.rule.id,
      base: figures === null ? null : figures.base.toString(),
      tax: figures === null ? null : figures.tax.toString(),
    });
  }

  let base = Money.zero();
  let taxTotal = Money.zero();
  const taxLines: TaxGroup[] = [];
  for (const group of groups.values()) {
    if (!perLine) {
      const figures = pricesIncludeTax
        ? splitGross(group.amount, group.rate)
        : { base: group.amount, tax: taxOf(group.amount, group.rate) };
      group.base = figures.base;
      group.tax = figures.tax;
    }
    base = base.add(group.base);
    taxTotal = taxTotal.add(group.tax);
    taxLines.push({
      authorityCode: group.rule.authorityCode,
      taxCode: group.rule.taxCode,
      ratePercent: group.rate.toString(),
      ruleIds: [...group.ruleIds].sort(),
      base: group.base.toString(),
      tax: group.tax.toString(),
    });
  }
  return {
    roundingMode,
    pricesIncludeTax,
    base: base.toString(),
    taxTotal: taxTotal.toString(),
    total: base.add(taxTotal).toString(),
    taxLines,
    lines: results,
  };
}

export interface WithholdingRuleRef {
  id: string;
  ratePercent: string;
  base: 'on_invoice_total' | 'on_tax_amount' | 'on_base';
}

export interface WithholdingBases {
  invoiceTotal: string;
  taxAmount: string;
  base: string;
}

export interface WithholdingResult {
  ruleId: string;
  basis: WithholdingRuleRef['base'];
  ratePercent: string;
  baseAmount: string;
  amount: string;
}

/** BR-4: the rule's rate on the stated base, rounded half-up to 2 decimals. */
export function calculateWithholding(
  rule: WithholdingRuleRef,
  bases: WithholdingBases,
): WithholdingResult {
  const picked = {
    on_invoice_total: bases.invoiceTotal,
    on_tax_amount: bases.taxAmount,
    on_base: bases.base,
  }[rule.base];
  const baseAmount = Money.of(picked);
  const rate = Percent.of(rule.ratePercent);
  return {
    ruleId: rule.id,
    basis: rule.base,
    ratePercent: rate.toString(),
    baseAmount: baseAmount.toString(),
    amount: roundMoney(baseAmount.percent(rate)).toString(),
  };
}
