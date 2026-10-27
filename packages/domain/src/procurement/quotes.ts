import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { lineTotal } from './rules.js';

export interface QuoteView {
  quoteId: string;
  /** Requisition line id to rate (4 decimals). */
  rates: ReadonlyMap<string, string>;
}

export interface LineView {
  id: string;
  quantity: string;
}

export interface Comparison {
  /** Per requisition line: the quotes ranked by rate, cheapest first (ties by quote id). */
  byLine: Map<string, { quoteId: string; rate: string; rank: number }[]>;
  /** Per quote: the total over the lines it quotes, and whether it quotes every line. */
  totals: { quoteId: string; total: string; complete: boolean; rank: number }[];
}

const byAmount = (a: string, b: string): number => new Decimal(a).comparedTo(new Decimal(b));

/** BR-2: the comparison view ranks by line rate and by total (complete quotes first). */
export function compareQuotes(
  lines: readonly LineView[],
  quotes: readonly QuoteView[],
): Comparison {
  const byLine: Comparison['byLine'] = new Map();
  for (const line of lines) {
    const ranked = quotes
      .filter((quote) => quote.rates.has(line.id))
      .map((quote) => ({ quoteId: quote.quoteId, rate: quote.rates.get(line.id) as string }))
      .sort((a, b) => byAmount(a.rate, b.rate) || a.quoteId.localeCompare(b.quoteId));
    byLine.set(
      line.id,
      ranked.map((entry, index) => ({ ...entry, rank: index + 1 })),
    );
  }
  const totals = quotes
    .map((quote) => {
      const quoted = lines.filter((line) => quote.rates.has(line.id));
      const total = quoted
        .reduce(
          (sum, line) => sum.plus(lineTotal(line.quantity, quote.rates.get(line.id) as string)),
          new Decimal(0),
        )
        .toFixed(2);
      return { quoteId: quote.quoteId, total, complete: quoted.length === lines.length };
    })
    .sort(
      (a, b) =>
        Number(b.complete) - Number(a.complete) ||
        byAmount(a.total, b.total) ||
        a.quoteId.localeCompare(b.quoteId),
    )
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  return { byLine, totals };
}

/**
 * BR-2: the chosen quote must quote the line, and a quote that is not the lowest rate for the line
 * needs a written reason. A tie for the lowest rate counts as lowest.
 */
export function assertSelection(
  ranking: readonly { quoteId: string; rate: string }[],
  chosenQuoteId: string,
  reason: string | null | undefined,
): void {
  const chosen = ranking.find((entry) => entry.quoteId === chosenQuoteId);
  if (chosen === undefined) {
    throw new ValidationError('quote_line_missing', 'The chosen quote has no rate for this line');
  }
  const lowest = (ranking[0] as { rate: string }).rate;
  if (byAmount(chosen.rate, lowest) > 0 && (reason ?? '').trim() === '') {
    throw new RuleViolationError(
      'selection_reason_required',
      'Choosing a vendor that is not the lowest rate needs a written reason',
    );
  }
}
