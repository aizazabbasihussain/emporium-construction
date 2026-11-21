import { BusinessDate, Money } from '@emporium/domain/kernel';
import {
  billFigures,
  coveredQuantity,
  exceedsCommitments,
  lineAmount,
  lineVariance,
  matchLine,
  varianceTreatment,
  type MatchResult,
} from '@emporium/domain/payables';
import {
  billSeries,
  payablesPermissions,
  payablesSettingKeys,
  vendorBillDocType,
  type BillSourceType,
  type BillStatus,
  type VarianceTreatment,
} from '@emporium/shared';
import {
  assertBillCancellable,
  assertBillDraft,
  assertBillEditable,
  assertBillLocation,
  assertBillTransition,
  assertCostTarget,
  assertDueDate,
  assertEnteredBy,
  assertFound,
  assertMatchAccepted,
  assertNotDuplicate,
  assertOpeningAmount,
  assertPostable,
  assertPurchaseLine,
  assertReceiptLine,
  assertSourceRegistered,
  assertUpdated,
  assertVarianceCostCode,
  assertVendor,
  assertVersion,
} from '../policy/payables.policy.js';
import {
  billedQuantity,
  coveredValue,
  findBill,
  findBillByInvoice,
  hasLiveAllocations,
  insertBill,
  insertVariance,
  isGrnBilled as grnBilled,
  listBillFigures,
  listLines,
  listMatches,
  listVariances,
  markVarianceReversed,
  receiptCostConfirmed,
  receiptSharedByOthers,
  replaceLines,
  replaceMatches,
  searchBills,
  setLineCostEntry,
  updateBill,
  type BillRow,
  type LineRow,
  type NewLine,
} from '../repo/payables.repo.js';
import type {
  Actor,
  BillDto,
  BillLineDto,
  CostObjectRef,
  Db,
  MatchDto,
  PageResult,
  VarianceDto,
} from '../types.js';
import { overheadObject, requiredText, textOrNull, type Context } from './context.js';

export interface BillLineInput {
  /** Purchase lines name the receipt and its line. */
  grnId?: string | undefined;
  grnLineId?: string | undefined;
  description?: string | undefined;
  quantity: string;
  rate: string;
  /** Other sources name the cost object and code; a purchase line may redirect its cost object. */
  costObjectType?: CostObjectRef['type'] | undefined;
  costObjectId?: string | undefined;
  costCodeId?: string | undefined;
}

export interface BillInput {
  vendorPartyId: string;
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
  sourceType: Exclude<BillSourceType, 'opening'>;
  supplyKind?: 'goods' | 'services' | undefined;
  nature?: string | undefined;
  locationId?: string | undefined;
  notes?: string | undefined;
  lines: BillLineInput[];
}

export interface OpeningBillInput {
  vendorPartyId: string;
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
  amount: string;
  notes?: string | undefined;
}

/** BR-6: what a source of bills (subcontract certificates, P2-06) provides. */
export interface ProviderBill {
  vendorPartyId: string;
  supplyKind?: 'goods' | 'services' | undefined;
  nature?: string | undefined;
  locationId?: string | undefined;
  lines: {
    description: string;
    quantity: string;
    rate: string;
    costObject: CostObjectRef;
    costCodeId: string;
    /** The approved cost entry the bill confirms when it is posted. */
    sourceEntryId?: string | undefined;
  }[];
}

export interface BillSourceProvider {
  buildBill(db: Db, sourceDocId: string): Promise<ProviderBill>;
  onPosted(tx: Db, input: { billId: string; sourceDocId: string }): Promise<void>;
  onCancelled(
    tx: Db,
    input: { billId: string; sourceDocId: string; reason: string },
  ): Promise<void>;
}

export interface BillService {
  create(input: BillInput, actor: Actor, tx: Db): Promise<BillDto>;
  /** BR-6: a bill built from a registered source document. */
  createFromSource(
    sourceType: Exclude<BillSourceType, 'opening' | 'purchase'>,
    sourceDocId: string,
    input: {
      vendorInvoiceNo: string;
      billDate: string;
      dueDate: string;
      notes?: string | undefined;
    },
    actor: Actor,
    tx: Db,
  ): Promise<BillDto>;
  /** BR-12: an opening vendor balance; posted at once, no cost posted. */
  createOpening(input: OpeningBillInput, actor: Actor, tx: Db): Promise<BillDto>;
  update(id: string, version: number, input: BillInput, actor: Actor, tx: Db): Promise<BillDto>;
  match(
    id: string,
    input: { version: number; overrideReason?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<BillDto>;
  submit(id: string, version: number, actor: Actor, tx: Db): Promise<BillDto>;
  post(id: string, version: number, actor: Actor, tx: Db): Promise<BillDto>;
  cancel(
    id: string,
    input: { reason: string; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<BillDto>;
  get(db: Db, id: string): Promise<BillDto>;
  list(
    db: Db,
    query: {
      vendorPartyId?: string | undefined;
      status?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<PageResult<BillDto>>;
  registerBillSource(
    type: Exclude<BillSourceType, 'opening' | 'purchase'>,
    provider: BillSourceProvider,
  ): void;
  onApprovalOutcome(
    outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
    payload: { docId: string },
    tx: Db,
  ): Promise<void>;
  isGrnBilled(db: Db, grnId: string): Promise<boolean>;
}

export function createBillService(ctx: Context): BillService {
  const { platform, clock, newId, procurement, inventory, projects, tax, approvals, masterData } =
    ctx;
  const providers = new Map<string, BillSourceProvider>();

  const toLineDto = (row: LineRow): BillLineDto => ({
    id: row.id,
    lineNo: row.line_no,
    sourceDocType: row.source_doc_type,
    sourceDocId: row.source_doc_id,
    poLineId: row.po_line_id,
    grnLineId: row.grn_line_id,
    description: row.description,
    quantity: row.quantity,
    rate: row.rate,
    amount: row.amount,
    costObjectType: row.cost_object_type as CostObjectRef['type'],
    costObjectId: row.cost_object_id,
    costCodeId: row.cost_code_id,
    costEntryId: row.cost_entry_id,
  });

  /** The receipt, its order and the lines of both (a missing line is refused by the policy). */
  async function receiptFacts(db: Db, grnId: string, grnLineId: string) {
    const grn = await procurement.getGrn(db, grnId);
    const line = grn.lines.find((l) => l.id === grnLineId);
    const po = await procurement.getPurchaseOrder(db, grn.poId);
    const poLine = po.lines.find((l) => l.id === line?.poLineId);
    return { grn, line, po, poLine };
  }

  /** BR-1: turns the lines of a request into rows with their cost object, code and amount. */
  async function resolveLines(
    db: Db,
    input: Pick<BillInput, 'vendorPartyId' | 'sourceType' | 'lines'>,
  ): Promise<NewLine[]> {
    const out: NewLine[] = [];
    for (const [index, line] of input.lines.entries()) {
      const amount = lineAmount(line.quantity, line.rate);
      const base = {
        id: newId(),
        lineNo: index + 1,
        description: textOrNull(line.description) ?? '',
        quantity: line.quantity,
        rate: line.rate,
        amount,
      };
      if (input.sourceType === 'purchase') {
        assertPurchaseLine(line.grnId, line.grnLineId);
        const facts = await receiptFacts(db, line.grnId as string, line.grnLineId as string);
        assertReceiptLine({
          line: facts.line,
          grnStatus: facts.grn.status,
          orderVendorId: facts.po.vendorId,
          vendorPartyId: input.vendorPartyId,
        });
        const poLine = facts.poLine as NonNullable<typeof facts.poLine>;
        const fallback: CostObjectRef =
          facts.po.projectId === null
            ? overheadObject
            : { type: 'project', id: facts.po.projectId };
        const object: CostObjectRef =
          line.costObjectType === undefined
            ? fallback
            : { type: line.costObjectType, id: line.costObjectId ?? null };
        out.push({
          ...base,
          description: base.description === '' ? poLine.description : base.description,
          sourceDocType: 'goods_receipt',
          sourceDocId: facts.grn.id,
          poLineId: poLine.id,
          grnLineId: line.grnLineId as string,
          costObjectType: object.type,
          costObjectId: object.id,
          costCodeId: line.costCodeId ?? poLine.costCodeId,
          sourceEntryId: (facts.line as NonNullable<typeof facts.line>).costEntryId,
        });
      } else {
        assertCostTarget(line);
        out.push({
          ...base,
          sourceDocType: null,
          sourceDocId: null,
          poLineId: null,
          grnLineId: null,
          costObjectType: line.costObjectType as string,
          costObjectId: line.costObjectId ?? null,
          costCodeId: line.costCodeId as string,
          sourceEntryId: null,
        });
      }
    }
    return out;
  }

  const sumAmounts = (lines: readonly { amount: string }[]) =>
    lines.reduce((s, l) => s.add(Money.of(l.amount)), Money.zero()).toString();

  async function dtoOf(db: Db, row: BillRow): Promise<BillDto> {
    const lines = await listLines(db, row.id);
    const matches: MatchDto[] = (await listMatches(db, row.id)).map((m) => ({
      billLineId: m.bill_line_id,
      poRate: m.po_rate,
      grnQty: m.grn_qty,
      billedQty: m.billed_qty,
      billedRate: m.billed_rate,
      qtyVariance: m.qty_variance,
      rateVariance: m.rate_variance,
      withinTolerance: m.within_tolerance,
    }));
    const variances: VarianceDto[] = (await listVariances(db, row.id)).map((v) => ({
      id: v.id,
      billLineId: v.bill_line_id,
      costObjectType: v.cost_object_type as CostObjectRef['type'],
      costObjectId: v.cost_object_id,
      amount: v.amount,
      treatment: v.treatment as VarianceTreatment,
      ledgerEntryId: v.ledger_entry_id,
      reversedOn: v.reversed_on,
    }));
    const [figures] = await listBillFigures(db, { asOf: ctx.today(), billIds: [row.id] });
    const allocated = figures?.allocated ?? '0.00';
    const warnings: string[] = [];
    // What the receipts cover is known only once the bill is matched.
    if (row.status === 'matched') {
      const open = await procurement.listOpenPoLines(db, { vendorId: row.vendor_party_id });
      const openOrderValue = open
        .reduce((s, l) => s.add(Money.of(lineAmount(l.openQty, l.rate))), Money.zero())
        .toString();
      if (
        exceedsCommitments({
          billBase: row.base_amount,
          coveredValue: await coveredValue(db, row.id),
          openOrderValue,
        })
      ) {
        warnings.push('above_open_commitments');
      }
    }
    const state = await approvals.getApprovalState(db, vendorBillDocType, row.id);
    return {
      id: row.id,
      number: row.number,
      vendorPartyId: row.vendor_party_id,
      vendorInvoiceNo: row.vendor_invoice_no,
      billDate: row.bill_date,
      dueDate: row.due_date,
      sourceType: row.source_type as BillSourceType,
      sourceDocId: row.source_doc_id,
      status: row.status as BillStatus,
      supplyKind: row.supply_kind as 'goods' | 'services',
      nature: row.nature,
      locationId: row.location_id,
      baseAmount: row.base_amount,
      taxTotal: row.tax_total,
      grossTotal: row.gross_total,
      withholdingTotal: row.withholding_total,
      netPayable: row.net_payable,
      authorityCode: row.authority_code,
      notes: row.notes,
      matchOverrideReason: row.match_override_reason,
      postedOn: row.posted_on,
      cancelledOn: row.cancelled_on,
      cancelReason: row.cancel_reason,
      createdBy: row.created_by,
      version: row.version,
      lines: lines.map(toLineDto),
      matches,
      variances,
      allocated,
      outstanding:
        figures === undefined
          ? '0.00'
          : Money.of(row.gross_total).sub(Money.of(allocated)).toString(),
      warnings,
      taxSnapshot: row.tax_snapshot,
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
    };
  }

  const changed = (row: BillRow, change: string) => ({
    type: 'payables.bill.changed',
    payload: { billId: row.id, vendorPartyId: row.vendor_party_id, status: row.status, change },
  });

  async function lockedBill(tx: Db, id: string, version: number): Promise<BillRow> {
    const row = assertFound(await findBill(tx, id, true), 'bill');
    assertVersion(row.version, version);
    return row;
  }

  async function checkHeader(
    tx: Db,
    input: BillInput | OpeningBillInput,
    actor: Actor,
    exceptId?: string,
  ) {
    assertVendor(await masterData.getParty(tx, input.vendorPartyId));
    assertDueDate(input.billDate, input.dueDate);
    const existing = await findBillByInvoice(tx, input.vendorPartyId, input.vendorInvoiceNo.trim());
    assertNotDuplicate(existing?.id === exceptId ? undefined : existing);
    await ctx.checkDate(tx, input.billDate, actor, 'pay_bill');
  }

  async function insert(
    tx: Db,
    actor: Actor,
    header: {
      input: BillInput;
      sourceDocId: string | null;
    },
    lines: NewLine[],
  ): Promise<BillDto> {
    const { input } = header;
    const id = newId();
    const base = sumAmounts(lines);
    const row = await insertBill(
      tx,
      {
        id,
        number: await platform.numbering.next(billSeries, tx),
        vendor_party_id: input.vendorPartyId,
        vendor_invoice_no: input.vendorInvoiceNo.trim(),
        bill_date: BusinessDate.parse(input.billDate).toString(),
        due_date: BusinessDate.parse(input.dueDate).toString(),
        source_type: input.sourceType,
        source_doc_id: header.sourceDocId,
        status: 'draft',
        supply_kind: input.supplyKind ?? (input.sourceType === 'purchase' ? 'goods' : 'services'),
        nature: textOrNull(input.nature) ?? '',
        location_id: input.locationId ?? null,
        base_amount: base,
        gross_total: base,
        net_payable: base,
        notes: textOrNull(input.notes),
      },
      actor.userId,
      clock.now(),
    );
    await replaceLines(tx, id, lines);
    await ctx.record(tx, actor, {
      action: 'payables.bill.create',
      entityType: 'pay_bill',
      entityId: id,
      after: { number: row.number, vendorPartyId: row.vendor_party_id, base },
      event: changed(row, 'created'),
    });
    return dtoOf(tx, row);
  }

  /** BR-3, BR-4: input tax and withholding we deduct from the engine; refuses without rules. */
  async function figuresOf(db: Db, row: BillRow, lines: readonly LineRow[]) {
    const projectLine = lines.find((l) => l.cost_object_type === 'project');
    const locationId = assertBillLocation(
      row.location_id ??
        (projectLine === undefined
          ? null
          : (await projects.getProject(db, projectLine.cost_object_id as string)).locationId),
    );
    const snapshot = await tax.calculateSalesTax(db, {
      locationId,
      supplyKind: row.supply_kind as 'goods' | 'services',
      date: row.bill_date,
      lines: lines.map((l) => ({
        id: String(l.line_no),
        amount: l.amount,
        nature: textOrNull(row.nature),
      })),
    });
    const withheld = await tax.calculateWithholding(db, {
      direction: 'we_withhold',
      authorityCode: snapshot.authorityCode,
      partyType: row.source_type === 'subcontract' ? 'subcontractor' : 'vendor',
      nature: row.nature,
      date: row.bill_date,
      invoiceTotal: snapshot.total,
      taxAmount: snapshot.taxTotal,
      base: snapshot.base,
    });
    const withholdingTotal = withheld
      .reduce((s, w) => s.add(Money.of(w.amount)), Money.zero())
      .toString();
    return {
      snapshot,
      withheld,
      locationId,
      ...billFigures({ gross: snapshot.total, withholdingTotal }),
      base: snapshot.base,
      taxTotal: snapshot.taxTotal,
    };
  }

  /** H-22: the overhead cost code that takes a price variance on goods still in stock. */
  async function varianceCostCode(tx: Db): Promise<string> {
    const code = await ctx.setting(tx, payablesSettingKeys.priceVarianceCostCode);
    const found = (await masterData.costing.listCostCodes(tx)).find(
      (c) => c.code === code && c.active,
    );
    return assertVarianceCostCode(found?.id);
  }

  /** BR-5: the line's price variance, posted as cost per the treatment of H-22. */
  async function postVariance(
    tx: Db,
    row: BillRow,
    line: LineRow,
    match: { qty_variance: string; po_rate: string },
    actor: Actor,
  ): Promise<void> {
    const amount = lineVariance({
      billedAmount: line.amount,
      coveredQty: coveredQuantity(line.quantity, match.qty_variance),
      poRate: match.po_rate,
    });
    if (Money.of(amount).isZero()) return;
    const facts = await receiptFacts(tx, line.source_doc_id as string, line.grn_line_id as string);
    const treatment = varianceTreatment({
      destination: facts.po.destinationType,
      issued: await inventory.hasIssuesFromGrn(tx, facts.grn.id),
    });
    const object: CostObjectRef =
      treatment === 'project_cost'
        ? { type: line.cost_object_type as CostObjectRef['type'], id: line.cost_object_id }
        : overheadObject;
    const costCodeId =
      treatment === 'project_cost' ? line.cost_code_id : await varianceCostCode(tx);
    const entry = await projects.postCost(
      {
        costObject: object,
        costCodeId,
        amount,
        status: 'posted',
        sourceModule: 'payables',
        sourceDocType: 'price_variance',
        sourceDocId: row.id,
        sourceLineId: line.id,
        entryDate: ctx.today(),
        description: `Price variance ${row.number} line ${line.line_no}`,
        idempotencyKey: `bill:${row.id}:variance:${line.id}`,
        actorUserId: actor.userId,
      },
      tx,
    );
    await insertVariance(
      tx,
      {
        id: newId(),
        bill_id: row.id,
        bill_line_id: line.id,
        cost_object_type: object.type,
        cost_object_id: object.id,
        amount,
        treatment,
        ledger_entry_id: entry.id,
      },
      actor.userId,
      clock.now(),
    );
  }

  /** BR-5: the cost of one line moves to `posted` (or is posted at once when nothing was approved). */
  async function postLine(
    tx: Db,
    row: BillRow,
    line: LineRow,
    matches: ReadonlyMap<string, { qty_variance: string; po_rate: string }>,
    actor: Actor,
  ): Promise<void> {
    if (line.grn_line_id === null) {
      const entry =
        line.source_entry_id === null
          ? await projects.postCost(
              {
                costObject: {
                  type: line.cost_object_type as CostObjectRef['type'],
                  id: line.cost_object_id,
                },
                costCodeId: line.cost_code_id,
                amount: line.amount,
                status: 'posted',
                sourceModule: 'payables',
                sourceDocType: 'vendor_bill',
                sourceDocId: row.id,
                sourceLineId: line.id,
                entryDate: ctx.today(),
                description: `Bill ${row.number} line ${line.line_no}`,
                idempotencyKey: `bill:${row.id}:line:${line.id}`,
                actorUserId: actor.userId,
              },
              tx,
            )
          : await projects.transitionCost(line.source_entry_id, 'posted', tx, actor.userId);
      await setLineCostEntry(tx, line.id, entry.id);
      return;
    }
    if (
      line.source_entry_id !== null &&
      !(await receiptCostConfirmed(tx, line.grn_line_id, row.id))
    ) {
      const entry = await projects.transitionCost(line.source_entry_id, 'posted', tx, actor.userId);
      await setLineCostEntry(tx, line.id, entry.id);
    }
    await postVariance(
      tx,
      row,
      line,
      matches.get(line.id) as { qty_variance: string; po_rate: string },
      actor,
    );
  }

  /** BR-10: gives a receipt cost back as approved cost after its posted entry is reversed. */
  async function reopenReceiptCost(tx: Db, row: BillRow, line: LineRow, actor: Actor) {
    const facts = await receiptFacts(tx, line.source_doc_id as string, line.grn_line_id as string);
    const grnLine = facts.line as NonNullable<typeof facts.line>;
    await projects.postCost(
      {
        costObject: { type: 'project', id: facts.po.projectId },
        costCodeId: (facts.poLine as NonNullable<typeof facts.poLine>).costCodeId,
        amount: grnLine.costAmount,
        status: 'approved',
        sourceModule: 'procurement',
        sourceDocType: 'goods_receipt',
        sourceDocId: facts.grn.id,
        sourceLineId: grnLine.id,
        entryDate: facts.grn.receivedOn,
        description: `Goods received ${facts.grn.number}`,
        idempotencyKey: `bill:${row.id}:reopen:${line.id}`,
        actorUserId: actor.userId,
      },
      tx,
    );
  }

  const service: BillService = {
    async create(input, actor, tx) {
      await checkHeader(tx, input, actor);
      return insert(tx, actor, { input, sourceDocId: null }, await resolveLines(tx, input));
    },

    async createFromSource(sourceType, sourceDocId, input, actor, tx) {
      const provider = providers.get(sourceType);
      assertSourceRegistered(provider, sourceType);
      const built = await (provider as BillSourceProvider).buildBill(tx, sourceDocId);
      const full: BillInput = {
        vendorPartyId: built.vendorPartyId,
        vendorInvoiceNo: input.vendorInvoiceNo,
        billDate: input.billDate,
        dueDate: input.dueDate,
        sourceType,
        supplyKind: built.supplyKind,
        nature: built.nature,
        locationId: built.locationId,
        notes: input.notes,
        lines: built.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          costObjectType: l.costObject.type,
          costObjectId: l.costObject.id ?? undefined,
          costCodeId: l.costCodeId,
        })),
      };
      await checkHeader(tx, full, actor);
      const lines = (await resolveLines(tx, full)).map((line, index) => ({
        ...line,
        sourceDocType: sourceType,
        sourceDocId,
        sourceEntryId: built.lines[index]?.sourceEntryId ?? null,
      }));
      return insert(tx, actor, { input: full, sourceDocId }, lines);
    },

    async createOpening(input, actor, tx) {
      assertOpeningAmount(input.amount);
      await checkHeader(tx, input, actor);
      const amount = Money.of(input.amount).toString();
      const date = BusinessDate.parse(input.billDate).toString();
      const row = await insertBill(
        tx,
        {
          id: newId(),
          number: await platform.numbering.next(billSeries, tx),
          vendor_party_id: input.vendorPartyId,
          vendor_invoice_no: input.vendorInvoiceNo.trim(),
          bill_date: date,
          due_date: BusinessDate.parse(input.dueDate).toString(),
          source_type: 'opening',
          status: 'posted',
          base_amount: amount,
          gross_total: amount,
          net_payable: amount,
          notes: textOrNull(input.notes),
          posted_on: date,
          posted_by: actor.userId,
        },
        actor.userId,
        clock.now(),
      );
      await ctx.record(tx, actor, {
        action: 'payables.bill.opening',
        entityType: 'pay_bill',
        entityId: row.id,
        after: { number: row.number, amount },
        event: {
          type: 'bill.posted',
          payload: {
            billId: row.id,
            number: row.number,
            vendorPartyId: row.vendor_party_id,
            grossTotal: amount,
            netPayable: amount,
            withholdingTotal: '0.00',
            sourceType: 'opening',
            sourceDocId: null,
          },
        },
      });
      return dtoOf(tx, row);
    },

    async update(id, version, input, actor, tx) {
      const row = await lockedBill(tx, id, version);
      assertBillEditable(row.status as BillStatus);
      await checkHeader(tx, input, actor, id);
      const lines = await resolveLines(tx, input);
      const next = assertUpdated(
        await updateBill(
          tx,
          id,
          version,
          {
            vendor_party_id: input.vendorPartyId,
            vendor_invoice_no: input.vendorInvoiceNo.trim(),
            bill_date: BusinessDate.parse(input.billDate).toString(),
            due_date: BusinessDate.parse(input.dueDate).toString(),
            source_type: input.sourceType,
            status: 'draft',
            supply_kind:
              input.supplyKind ?? (input.sourceType === 'purchase' ? 'goods' : 'services'),
            nature: textOrNull(input.nature) ?? '',
            location_id: input.locationId ?? null,
            base_amount: sumAmounts(lines),
            gross_total: sumAmounts(lines),
            net_payable: sumAmounts(lines),
            tax_total: '0',
            withholding_total: '0',
            tax_snapshot: null,
            authority_code: null,
            match_override_reason: null,
            match_overridden_by: null,
            notes: textOrNull(input.notes),
          },
          actor.userId,
          clock.now(),
        ),
      );
      await replaceLines(tx, id, lines);
      await ctx.record(tx, actor, {
        action: 'payables.bill.update',
        entityType: 'pay_bill',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status, base: next.base_amount },
        event: changed(next, 'updated'),
      });
      return dtoOf(tx, next);
    },

    async match(id, input, actor, tx) {
      const row = await lockedBill(tx, id, input.version);
      assertBillDraft(row.status as BillStatus);
      const qtyTolerance = await ctx.setting(tx, payablesSettingKeys.qtyTolerancePercent);
      const rateTolerance = await ctx.setting(tx, payablesSettingKeys.rateTolerancePercent);
      const lines = await listLines(tx, id);
      const results: { line: LineRow; result: MatchResult }[] = [];
      for (const line of lines.filter((l) => l.grn_line_id !== null)) {
        const facts = await receiptFacts(
          tx,
          line.source_doc_id as string,
          line.grn_line_id as string,
        );
        results.push({
          line,
          result: matchLine({
            poRate: (facts.poLine as NonNullable<typeof facts.poLine>).rate,
            receivedQty: (facts.line as NonNullable<typeof facts.line>).acceptedQty,
            billedBefore: await billedQuantity(tx, line.grn_line_id as string, id),
            billedQty: line.quantity,
            billedRate: line.rate,
            qtyTolerancePercent: qtyTolerance,
            rateTolerancePercent: rateTolerance,
          }),
        });
      }
      const allWithin = results.every((r) => r.result.withinTolerance);
      assertMatchAccepted({
        allWithinTolerance: allWithin,
        overrideReason: input.overrideReason,
        canOverride: actor.permissions.has(payablesPermissions.billOverrideMatch),
      });
      await replaceMatches(
        tx,
        id,
        results.map(({ line, result }) => ({
          billLineId: line.id,
          poRate: result.poRate,
          grnQty: result.grnQty,
          billedQty: result.billedQty,
          billedRate: result.billedRate,
          qtyVariance: result.qtyVariance,
          rateVariance: result.rateVariance,
          withinTolerance: result.withinTolerance,
        })),
      );
      assertBillTransition('draft', 'matched');
      const next = assertUpdated(
        await updateBill(
          tx,
          id,
          input.version,
          {
            status: 'matched',
            match_override_reason: allWithin ? null : requiredText(input.overrideReason, 'reason'),
            match_overridden_by: allWithin ? null : actor.userId,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await ctx.record(tx, actor, {
        action: 'payables.bill.match',
        entityType: 'pay_bill',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status, overridden: !allWithin },
        event: changed(next, 'matched'),
      });
      return dtoOf(tx, next);
    },

    async submit(id, version, actor, tx) {
      const row = await lockedBill(tx, id, version);
      assertEnteredBy(row.created_by, actor.userId);
      assertBillTransition(row.status as BillStatus, 'pending_approval');
      const lines = await listLines(tx, id);
      const figures = await figuresOf(tx, row, lines);
      const next = assertUpdated(
        await updateBill(
          tx,
          id,
          version,
          {
            status: 'pending_approval',
            location_id: figures.locationId,
            base_amount: figures.base,
            tax_total: figures.taxTotal,
            gross_total: figures.gross,
            withholding_total: figures.withholdingTotal,
            net_payable: figures.netPayable,
            authority_code: figures.snapshot.authorityCode,
            tax_snapshot: JSON.stringify({
              sales: figures.snapshot,
              withholding: figures.withheld,
            }),
          },
          actor.userId,
          clock.now(),
        ),
      );
      await approvals.requestApproval(
        {
          docType: vendorBillDocType,
          docId: id,
          amount: figures.gross,
          requesterId: actor.userId,
          context: {
            vendorPartyId: row.vendor_party_id,
            vendorInvoiceNo: row.vendor_invoice_no,
            baseAmount: figures.base,
            taxTotal: figures.taxTotal,
            grossTotal: figures.gross,
            withholdingTotal: figures.withholdingTotal,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      await ctx.record(tx, actor, {
        action: 'payables.bill.submit',
        entityType: 'pay_bill',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status, gross: figures.gross },
        event: changed(next, 'submitted'),
      });
      return dtoOf(tx, next);
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const row = await findBill(tx, payload.docId, true);
      if (row === undefined || row.status !== 'pending_approval') return;
      const to: BillStatus = outcome === 'approved' ? 'approved' : 'matched';
      assertBillTransition('pending_approval', to);
      const next = assertUpdated(
        await updateBill(tx, row.id, row.version, { status: to }, null, clock.now()),
      );
      await ctx.record(
        tx,
        { userId: null, requestId: null },
        {
          action: `payables.bill.${outcome}`,
          entityType: 'pay_bill',
          entityId: row.id,
          before: { status: row.status },
          after: { status: next.status },
          event: changed(next, outcome),
        },
      );
    },

    async post(id, version, actor, tx) {
      const row = await lockedBill(tx, id, version);
      assertPostable(row.status as BillStatus);
      const matches = new Map((await listMatches(tx, id)).map((m) => [m.bill_line_id, m] as const));
      for (const line of await listLines(tx, id)) {
        await postLine(tx, row, line, matches, actor);
      }
      assertBillTransition('approved', 'posted');
      const next = assertUpdated(
        await updateBill(
          tx,
          id,
          version,
          { status: 'posted', posted_on: ctx.today(), posted_by: actor.userId },
          actor.userId,
          clock.now(),
        ),
      );
      const provider = providers.get(row.source_type);
      if (provider !== undefined) {
        await provider.onPosted(tx, { billId: id, sourceDocId: row.source_doc_id as string });
      }
      await ctx.record(tx, actor, {
        action: 'payables.bill.post',
        entityType: 'pay_bill',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status },
        event: {
          type: 'bill.posted',
          payload: {
            billId: id,
            number: next.number,
            vendorPartyId: next.vendor_party_id,
            grossTotal: next.gross_total,
            netPayable: next.net_payable,
            withholdingTotal: next.withholding_total,
            sourceType: next.source_type,
            sourceDocId: next.source_doc_id,
          },
        },
      });
      return dtoOf(tx, next);
    },

    async cancel(id, input, actor, tx) {
      const row = await lockedBill(tx, id, input.version);
      assertBillCancellable({
        status: row.status as BillStatus,
        reason: input.reason,
        paymentsAllocated: await hasLiveAllocations(tx, id),
        receiptShared: await receiptSharedByOthers(tx, id),
      });
      const reason = input.reason.trim();
      if (row.status === 'posted') {
        for (const line of await listLines(tx, id)) {
          if (line.cost_entry_id === null) continue;
          await projects.reverseCost(
            line.cost_entry_id,
            `Bill ${row.number} cancelled: ${reason}`,
            tx,
            actor.userId,
          );
          if (line.grn_line_id !== null) await reopenReceiptCost(tx, row, line, actor);
        }
        for (const variance of await listVariances(tx, id)) {
          await projects.reverseCost(
            variance.ledger_entry_id,
            `Bill ${row.number} cancelled: ${reason}`,
            tx,
            actor.userId,
          );
          await markVarianceReversed(tx, variance.id, ctx.today());
        }
        const provider = providers.get(row.source_type);
        if (provider !== undefined) {
          await provider.onCancelled(tx, {
            billId: id,
            sourceDocId: row.source_doc_id as string,
            reason,
          });
        }
      }
      const next = assertUpdated(
        await updateBill(
          tx,
          id,
          input.version,
          { status: 'cancelled', cancelled_on: ctx.today(), cancel_reason: reason },
          actor.userId,
          clock.now(),
        ),
      );
      await ctx.record(tx, actor, {
        action: 'payables.bill.cancel',
        entityType: 'pay_bill',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status, reason },
        event: changed(next, 'cancelled'),
      });
      return dtoOf(tx, next);
    },

    async get(db, id) {
      return dtoOf(db, assertFound(await findBill(db, id), 'bill'));
    },

    async list(db, query) {
      const { rows, total } = await searchBills(db, query);
      return {
        items: await Promise.all(rows.map((row) => dtoOf(db, row))),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    registerBillSource(type, provider) {
      providers.set(type, provider);
    },

    isGrnBilled: (db, grnId) => grnBilled(db, grnId),
  };
  return service;
}
