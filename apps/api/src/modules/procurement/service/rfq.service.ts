import { ValidationError } from '@emporium/domain';
import {
  assertSelection,
  compareQuotes,
  lineTotal,
  parseQuantity,
  sumMoney,
  type RequisitionStatus,
} from '@emporium/domain/procurement';
import {
  assertDestinationReachable,
  assertFound,
  assertInvited,
  assertKnown,
  assertRequisitionOrderable,
  assertRfqOpen,
  assertUpdated,
} from '../policy/procurement.policy.js';
import {
  findQuote,
  findQuoteOfVendor,
  findRequisition,
  findRfq,
  insertQuote,
  insertRfq,
  listQuoteLines,
  listQuotes,
  listRequisitionLines,
  listRfqVendors,
  listSelections,
  replaceQuoteLines,
  searchRfqs,
  setRfqVendors,
  updateQuote,
  updateRfq,
  upsertSelection,
  type QuoteRow,
  type RfqRow,
} from '../repo/procurement.repo.js';
import type {
  Actor,
  ComparisonDto,
  Db,
  PageResult,
  QuoteDto,
  RfqDto,
  RfqHeaderDto,
} from '../types.js';
import type { Context } from './context.js';
import { pageOf, textOrNull } from './support.js';

export interface RfqInput {
  requisitionId: string;
  vendorIds: string[];
}

export interface QuoteInput {
  rfqId: string;
  vendorId: string;
  validUntil?: string | undefined;
  deliveryDays?: number | undefined;
  terms?: string | undefined;
  lines: { requisitionLineId: string; rate: string }[];
}

export type RfqService = ReturnType<typeof createRfqService>;

export function createRfqService(ctx: Context) {
  const { clock, record } = ctx;

  const changed = (row: RfqRow, action: string) => ({
    type: 'procurement.rfq.changed',
    payload: { rfqId: row.id, requisitionId: row.requisition_id, status: row.status, action },
  });

  const headerOf = async (db: Db, row: RfqRow): Promise<RfqHeaderDto> => ({
    id: row.id,
    requisitionId: row.requisition_id,
    number: row.number,
    status: row.status as 'open' | 'closed',
    vendorIds: await listRfqVendors(db, row.id),
    version: row.version,
  });

  /** An RFQ is reached through its requisition, so a scoped caller keeps to their projects. */
  async function reachable(db: Db, row: RfqRow, actor: Actor) {
    const requisition = assertFound(await findRequisition(db, row.requisition_id), 'requisition');
    assertDestinationReachable(
      actor,
      requisition.project_id === null
        ? { type: 'store', id: requisition.store_id as string }
        : { type: 'project', id: requisition.project_id },
    );
    return requisition;
  }

  const quoteOf = async (
    db: Db,
    row: QuoteRow,
    lines: { quote_id: string; requisition_line_id: string; rate: string }[],
  ): Promise<QuoteDto> => ({
    id: row.id,
    rfqId: row.rfq_id,
    vendorId: row.vendor_id,
    validUntil: row.valid_until,
    deliveryDays: row.delivery_days,
    terms: row.terms,
    total: row.total,
    lines: lines
      .filter((line) => line.quote_id === row.id)
      .map((line) => ({ requisitionLineId: line.requisition_line_id, rate: line.rate })),
    version: row.version,
  });

  async function dtoOf(db: Db, row: RfqRow): Promise<RfqDto> {
    const quotes = await listQuotes(db, row.id);
    const quoteLines = await listQuoteLines(db, row.id);
    const reqLines = await listRequisitionLines(db, row.requisition_id);
    const vendorOf = new Map(quotes.map((quote) => [quote.id, quote.vendor_id]));
    const comparison = compareQuotes(
      reqLines.map((line) => ({ id: line.id, quantity: line.quantity })),
      quotes.map((quote) => ({
        quoteId: quote.id,
        rates: new Map(
          quoteLines
            .filter((l) => l.quote_id === quote.id)
            .map((l) => [l.requisition_line_id, l.rate]),
        ),
      })),
    );
    const sheet: ComparisonDto = {
      lines: reqLines.map((line) => ({
        requisitionLineId: line.id,
        lineNo: line.line_no,
        quantity: line.quantity,
        ranking: (
          comparison.byLine.get(line.id) as { quoteId: string; rate: string; rank: number }[]
        ).map((entry) => ({
          ...entry,
          vendorId: vendorOf.get(entry.quoteId) as string,
        })),
      })),
      totals: comparison.totals.map((entry) => ({
        ...entry,
        vendorId: vendorOf.get(entry.quoteId) as string,
      })),
    };
    return {
      ...(await headerOf(db, row)),
      quotes: await Promise.all(quotes.map((quote) => quoteOf(db, quote, quoteLines))),
      selections: (await listSelections(db, row.id)).map((s) => ({
        requisitionLineId: s.requisition_line_id,
        quoteId: s.quote_id,
        vendorId: vendorOf.get(s.quote_id) as string,
        reason: s.reason,
      })),
      comparison: sheet,
    };
  }

  /** The lines of a quote must be lines of the RFQ's requisition, each at most once. */
  async function quoteTotal(db: Db, requisitionId: string, input: QuoteInput['lines']) {
    if (input.length === 0) throw new ValidationError('lines_required', 'Add at least one line');
    const reqLines = new Map(
      (await listRequisitionLines(db, requisitionId)).map((line) => [line.id, line.quantity]),
    );
    const seen = new Set<string>();
    const lines = input.map((line) => {
      assertKnown(
        reqLines.has(line.requisitionLineId),
        'line_not_found',
        'A quote line is not on the requisition',
      );
      assertKnown(!seen.has(line.requisitionLineId), 'duplicate_line', 'A line is quoted twice');
      seen.add(line.requisitionLineId);
      const rate = parseQuantity(line.rate, 'rate').toFixed(4);
      return {
        requisitionLineId: line.requisitionLineId,
        rate,
        amount: lineTotal(reqLines.get(line.requisitionLineId) as string, rate),
      };
    });
    return { lines, total: sumMoney(lines.map((line) => line.amount)) };
  }

  return {
    async list(
      db: Db,
      query: { requisitionId?: string | undefined; limit: number; offset: number },
      actor: Actor,
    ): Promise<PageResult<RfqHeaderDto>> {
      const { rows, total } = await searchRfqs(db, query);
      const visible: RfqHeaderDto[] = [];
      for (const row of rows) {
        await reachable(db, row, actor);
        visible.push(await headerOf(db, row));
      }
      return pageOf(visible, total, query);
    },

    async get(db: Db, id: string, actor: Actor): Promise<RfqDto> {
      const row = assertFound(await findRfq(db, id), 'rfq');
      await reachable(db, row, actor);
      return dtoOf(db, row);
    },

    /** BR-2 */
    async create(input: RfqInput, actor: Actor, tx: Db): Promise<RfqDto> {
      const requisition = assertFound(
        await findRequisition(tx, input.requisitionId),
        'requisition',
      );
      assertRequisitionOrderable(requisition.status as RequisitionStatus);
      const vendorIds = [...new Set(input.vendorIds)];
      if (vendorIds.length === 0) {
        throw new ValidationError('vendors_required', 'Invite at least one vendor');
      }
      for (const vendorId of vendorIds) await ctx.checkVendor(tx, vendorId);
      const row = await insertRfq(
        tx,
        {
          id: ctx.newId(),
          requisition_id: requisition.id,
          number: await ctx.numberFor(tx, 'rfq', 'RFQ'),
          status: 'open',
        },
        actor.userId,
        clock.now(),
      );
      await setRfqVendors(tx, row.id, vendorIds);
      await record(tx, actor, {
        action: 'procurement.rfq.create',
        entityType: 'prc_rfq',
        entityId: row.id,
        after: { number: row.number, vendors: vendorIds.length },
        event: changed(row, 'created'),
      });
      return dtoOf(tx, row);
    },

    async close(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<RfqDto> {
      const existing = assertFound(await findRfq(tx, id, true), 'rfq');
      if (existing.version !== expectedVersion) assertUpdated(undefined);
      assertRfqOpen(existing.status);
      const row = assertUpdated(
        await updateRfq(tx, id, expectedVersion, { status: 'closed' }, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'procurement.rfq.close',
        entityType: 'prc_rfq',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, 'closed'),
      });
      return dtoOf(tx, row);
    },

    async getQuote(db: Db, id: string, actor: Actor): Promise<QuoteDto> {
      const quote = assertFound(await findQuote(db, id), 'quote');
      await reachable(db, assertFound(await findRfq(db, quote.rfq_id), 'rfq'), actor);
      return quoteOf(db, quote, await listQuoteLines(db, quote.rfq_id));
    },

    /** BR-2: at least one rate per quote; one live quote per invited vendor. */
    async createQuote(input: QuoteInput, actor: Actor, tx: Db): Promise<QuoteDto> {
      const rfq = assertFound(await findRfq(tx, input.rfqId, true), 'rfq');
      assertRfqOpen(rfq.status);
      assertInvited(await listRfqVendors(tx, rfq.id), input.vendorId);
      assertKnown(
        (await findQuoteOfVendor(tx, rfq.id, input.vendorId)) === undefined,
        'quote_exists',
        'The vendor already has a quote; update it',
      );
      const { lines, total } = await quoteTotal(tx, rfq.requisition_id, input.lines);
      const row = await insertQuote(
        tx,
        {
          id: ctx.newId(),
          rfq_id: rfq.id,
          vendor_id: input.vendorId,
          valid_until: input.validUntil ?? null,
          delivery_days: input.deliveryDays ?? null,
          terms: textOrNull(input.terms) ?? '',
          total,
        },
        actor.userId,
        clock.now(),
      );
      await replaceQuoteLines(tx, row.id, lines);
      await record(tx, actor, {
        action: 'procurement.quote.create',
        entityType: 'prc_quote',
        entityId: row.id,
        after: { rfqId: rfq.id, vendorId: row.vendor_id, total },
        event: changed(rfq, 'quote-created'),
      });
      return quoteOf(tx, row, await listQuoteLines(tx, rfq.id));
    },

    async updateQuote(
      id: string,
      input: Omit<QuoteInput, 'rfqId' | 'vendorId'>,
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<QuoteDto> {
      const existing = assertFound(await findQuote(tx, id, true), 'quote');
      if (existing.version !== expectedVersion) assertUpdated(undefined);
      const rfq = assertFound(await findRfq(tx, existing.rfq_id, true), 'rfq');
      assertRfqOpen(rfq.status);
      const { lines, total } = await quoteTotal(tx, rfq.requisition_id, input.lines);
      const row = assertUpdated(
        await updateQuote(
          tx,
          id,
          expectedVersion,
          {
            valid_until: input.validUntil ?? null,
            delivery_days: input.deliveryDays ?? null,
            terms: textOrNull(input.terms) ?? '',
            total,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await replaceQuoteLines(tx, id, lines);
      await record(tx, actor, {
        action: 'procurement.quote.update',
        entityType: 'prc_quote',
        entityId: id,
        before: { total: existing.total },
        after: { total },
        event: changed(rfq, 'quote-updated'),
      });
      return quoteOf(tx, row, await listQuoteLines(tx, rfq.id));
    },

    /** BR-2: choose the quote for one requisition line; a dearer choice needs a written reason. */
    async selectVendor(
      rfqId: string,
      input: { requisitionLineId: string; quoteId: string; reason?: string | undefined },
      actor: Actor,
      tx: Db,
    ): Promise<RfqDto> {
      const rfq = assertFound(await findRfq(tx, rfqId, true), 'rfq');
      assertRfqOpen(rfq.status);
      const lineRates = (await listQuoteLines(tx, rfq.id)).filter(
        (line) => line.requisition_line_id === input.requisitionLineId,
      );
      assertKnown(lineRates.length > 0, 'line_not_quoted', 'No vendor has quoted this line');
      const ranking = compareQuotes(
        [{ id: input.requisitionLineId, quantity: '1' }],
        (await listQuotes(tx, rfq.id)).map((quote) => ({
          quoteId: quote.id,
          rates: new Map(
            lineRates
              .filter((line) => line.quote_id === quote.id)
              .map((line) => [line.requisition_line_id, line.rate]),
          ),
        })),
      ).byLine.get(input.requisitionLineId) as { quoteId: string; rate: string }[];
      const reason = textOrNull(input.reason);
      assertSelection(ranking, input.quoteId, reason);
      await upsertSelection(tx, rfq.id, input.requisitionLineId, input.quoteId, reason);
      await record(tx, actor, {
        action: 'procurement.rfq.select-vendor',
        entityType: 'prc_rfq',
        entityId: rfq.id,
        after: { requisitionLineId: input.requisitionLineId, quoteId: input.quoteId, reason },
        event: changed(rfq, 'vendor-selected'),
      });
      return dtoOf(tx, rfq);
    },
  };
}
