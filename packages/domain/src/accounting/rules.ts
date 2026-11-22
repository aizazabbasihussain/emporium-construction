/** The documents whose lines can carry an account tag (spec P2-09 BR-1). */
export type DocType =
  | 'invoice'
  | 'credit_note'
  | 'bill'
  | 'vendor_payment'
  | 'receipt'
  | 'cash_transaction'
  | 'payroll_run'
  | 'stock_movement'
  | 'expense_claim';

export interface MappingRule {
  id: string;
  sourceDocType: DocType;
  /** Attribute values a document must have for the rule to apply; empty matches every document. */
  condition: Readonly<Record<string, string>>;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveFrom: string;
  active: boolean;
}

/** One taggable line of a financial document, as an owning module reports it. */
export interface TaggableLine {
  docType: DocType;
  docId: string;
  lineRef: string;
  date: string;
  /** Facts a rule can test, for example `direction`, `method`, `kind`. */
  attrs: Readonly<Record<string, string>>;
}

export const lineKey = (line: Pick<TaggableLine, 'docType' | 'docId' | 'lineRef'>): string =>
  `${line.docType}|${line.docId}|${line.lineRef}`;

/** True when the rule's type, date and every named attribute fit the line. */
export function ruleApplies(rule: MappingRule, line: TaggableLine): boolean {
  return (
    rule.active &&
    rule.sourceDocType === line.docType &&
    rule.effectiveFrom <= line.date &&
    Object.entries(rule.condition).every(([key, value]) => line.attrs[key] === value)
  );
}

/**
 * BR-1: the rule that proposes the tag. The rule naming more attributes wins, then the one in force
 * since the later date, then the smaller id, so the choice never depends on the order of the list.
 */
export function pickRule(
  rules: readonly MappingRule[],
  line: TaggableLine,
): MappingRule | undefined {
  const fitting = rules.filter((rule) => ruleApplies(rule, line));
  fitting.sort(
    (a, b) =>
      Object.keys(b.condition).length - Object.keys(a.condition).length ||
      b.effectiveFrom.localeCompare(a.effectiveFrom) ||
      a.id.localeCompare(b.id),
  );
  return fitting[0];
}

/**
 * The tag takes the account the document is about rather than the bank or cash side: income for
 * a sale, the expense or asset for a purchase, the receivable for a receipt and the payable for a
 * vendor payment. For a cash transaction and a stock movement the direction decides.
 */
export function tagSide(line: Pick<TaggableLine, 'docType' | 'attrs'>): 'debit' | 'credit' {
  switch (line.docType) {
    case 'invoice':
    case 'receipt':
      return 'credit';
    case 'cash_transaction':
      return line.attrs.direction === 'in' ? 'credit' : 'debit';
    case 'stock_movement':
      return line.attrs.direction === 'issue' ? 'credit' : 'debit';
    default:
      return 'debit';
  }
}

export function tagAccountOf(rule: MappingRule, line: TaggableLine): string {
  return tagSide(line) === 'debit' ? rule.debitAccountCode : rule.creditAccountCode;
}

export interface TagProposal {
  line: TaggableLine;
  accountCode: string;
  ruleId: string;
}

export interface TagPlan {
  proposals: TagProposal[];
  /** Untagged lines no rule fits. */
  unmatched: TaggableLine[];
  /** Lines that already carry a tag; they are never changed (BR-1). */
  alreadyTagged: number;
}

/** BR-9: what the backfill would tag. Tagged lines are left alone, whatever the rules now say. */
export function planTags(
  lines: readonly TaggableLine[],
  taggedKeys: ReadonlySet<string>,
  rules: readonly MappingRule[],
): TagPlan {
  const plan: TagPlan = { proposals: [], unmatched: [], alreadyTagged: 0 };
  for (const line of lines) {
    if (taggedKeys.has(lineKey(line))) {
      plan.alreadyTagged += 1;
      continue;
    }
    const rule = pickRule(rules, line);
    if (rule === undefined) plan.unmatched.push(line);
    else plan.proposals.push({ line, accountCode: tagAccountOf(rule, line), ruleId: rule.id });
  }
  return plan;
}
