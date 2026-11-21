import {
  advanceRecovery,
  assertCancellableDirectly,
  assertEditable,
  assertRecoveryMethod,
  assertTransition,
  assertWithinContract,
  buildInvoicePrintModel,
  dueDateOf,
  grossTotal,
  invoiceSeriesFor,
  scheduleTotal,
  spreadReduction,
  taxableBase,
  type InvoicePrintModel,
  type InvoiceStatus,
} from '@emporium/domain/billing';
import { BusinessDate, Money, type Clock } from '@emporium/domain/kernel';
import {
  billingSettingKeys,
  invoiceDocType,
  invoiceSeries,
  type InvoiceSourceType,
  type SupplyKind,
} from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import type { Tax, TaxSnapshot } from '../../tax/index.js';
import {
  assertFiguresUnchanged,
  assertFound,
  assertProjectBillable,
  assertProjectHasLocation,
  assertProjectReachable,
  assertSingleSupplyKind,
  assertStagesAvailable,
  assertUpdated,
} from '../policy/billing.policy.js';
import {
  findAdvanceByInvoice,
  findInvoice,
  findStages,
  insertInvoice,
  issuedCreditBase,
  listLines,
  lockedAdvances,
  billedAsOf,
  netBilled,
  replaceLines,
  searchInvoices,
  setStagesStatus,
  stagesOnLiveInvoices,
  unappliedAdvance,
  updateAdvance,
  updateInvoice,
  type InvoiceRow,
} from '../repo/billing.repo.js';
import type { Actor, Db, InvoiceDto, InvoiceHeaderDto, PageResult } from '../types.js';
import type { ScheduleService } from './schedule.service.js';
import {
  createSourceRegistry,
  type InvoiceSourceProvider,
  type SourceLine,
  type SourceRegistry,
} from './sources.js';
import { createRecorder, pageOf, textOrNull } from './support.js';

export interface InvoiceInput {
  /** The invoice source (BR-12); `project_stage` unless another provider is registered. */
  source?: string | undefined;
  scheduleIds: string[];
  invoiceDate: string;
  /** BR-10: overrides the setting `billing.default_payment_days`. */
  paymentDays?: number | undefined;
  notes?: string | undefined;
  supplyKind?: SupplyKind | undefined;
  nature?: string | undefined;
}

export interface InvoiceQuery {
  projectId?: string | undefined;
  status?: InvoiceStatus | undefined;
  limit: number;
  offset: number;
}

/** BR-3, BR-4: every figure of an invoice, computed together. */
export interface InvoiceFigures {
  baseAmount: string;
  advanceRecovery: string;
  taxableBase: string;
  taxTotal: string;
  grossTotal: string;
  withholdingExpected: string;
  taxOnAdvanceAtReceipt: boolean;
  authorityCode: string;
  registrationNumber: string;
  dueDate: string;
  snapshot: TaxSnapshot;
}

export interface InvoiceService {
  registry: SourceRegistry;
  /** Module interfaces (spec section 2). */
  getInvoice(db: Db, id: string): Promise<InvoiceDto>;
  listInvoicesForProject(db: Db, projectId: string): Promise<InvoiceHeaderDto[]>;
  getBilledAmount(db: Db, projectId: string): Promise<string>;
  /** Billed base, tax and gross as of a date, net of credit notes, before advance recovery. */
  getProjectBilling(
    db: Db,
    projectId: string,
    asOf: string,
  ): Promise<{ base: string; tax: string; gross: string }>;
  registerInvoiceSource(type: string, provider: InvoiceSourceProvider): void;

  list(db: Db, query: InvoiceQuery, actor: Actor): Promise<PageResult<InvoiceHeaderDto>>;
  get(db: Db, id: string, actor: Actor): Promise<InvoiceDto>;
  create(projectId: string, input: InvoiceInput, actor: Actor, tx: Db): Promise<InvoiceDto>;
  /** An advance invoice for a stated amount (BR-8), used by the advance tracker. */
  createAdvanceInvoice(
    projectId: string,
    input: { amount: string; invoiceDate: string; notes?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<InvoiceDto>;
  update(
    id: string,
    input: InvoiceInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<InvoiceDto>;
  /** The figures and the tax of the saved draft, without changing it (the builder's tax preview). */
  preview(db: Db, id: string, actor: Actor): Promise<InvoiceFigures>;
  submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<InvoiceDto>;
  issue(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<InvoiceDto>;
  /** A draft, submitted or approved invoice that never reached the client. */
  cancel(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<InvoiceDto>;
  /** The decision of the approval engine on an invoice; replays are ignored. */
  onApprovalOutcome(
    outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
    payload: { docId: string },
    tx: Db,
  ): Promise<void>;
  printModel(db: Db, id: string): Promise<InvoicePrintModel>;
}

const headerOf = (row: InvoiceRow): InvoiceHeaderDto => ({
  id: row.id,
  number: row.number,
  seriesCode: row.series_code,
  authorityCode: row.authority_code,
  sourceType: row.source_type as InvoiceSourceType,
  projectId: row.project_id,
  partyId: row.party_id,
  invoiceDate: row.invoice_date,
  dueDate: row.due_date,
  status: row.status as InvoiceStatus,
  baseAmount: row.base_amount,
  advanceRecovery: row.advance_recovery,
  taxableBase: row.taxable_base,
  taxTotal: row.tax_total,
  grossTotal: row.gross_total,
  withholdingExpected: row.withholding_expected,
  registrationNumber: row.registration_number,
  taxOnAdvanceAtReceipt: row.tax_on_advance_at_receipt,
  paymentDays: row.payment_days,
  notes: row.notes,
  issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
  version: row.version,
});

/** The figures that approval covers; issuing compares them with a fresh computation (BR-6). */
const covered = (figures: {
  baseAmount: string;
  advanceRecovery: string;
  taxableBase: string;
  taxTotal: string;
  grossTotal: string;
  withholdingExpected: string;
  taxOnAdvanceAtReceipt: boolean;
}): Record<string, string> => ({
  baseAmount: figures.baseAmount,
  advanceRecovery: figures.advanceRecovery,
  taxableBase: figures.taxableBase,
  taxTotal: figures.taxTotal,
  grossTotal: figures.grossTotal,
  withholdingExpected: figures.withholdingExpected,
  taxOnAdvanceAtReceipt: String(figures.taxOnAdvanceAtReceipt),
});

const COUNTED = ['pending_approval', 'approved', 'issued'] as const;

export function createInvoiceService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject'>;
  tax: Pick<Tax, 'calculateSalesTax' | 'calculateWithholding'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  masterData: Pick<MasterData, 'getParty' | 'company' | 'getRegistration'>;
  schedule: ScheduleService;
}): InvoiceService {
  const { platform, clock, newId, projects, tax, approvals, masterData, schedule } = deps;
  const record = createRecorder(platform);
  const registry = createSourceRegistry();

  const setting = async (db: Db, key: string) => (await platform.settings.get(db, key)).value;

  // BR-12: the only provider of this spec turns planned stages into invoice lines.
  registry.register('project_stage', {
    async buildLines(db, request) {
      const stages = await findStages(db, request.projectId, request.scheduleIds);
      assertStagesAvailable({
        requested: request.scheduleIds,
        found: stages,
        taken: await stagesOnLiveInvoices(db, request.scheduleIds, request.exceptInvoiceId),
      });
      return {
        sourceType: stages.every((stage) => stage.source === 'variation')
          ? 'variation'
          : 'project_stage',
        lines: stages.map((stage): SourceLine => ({
          scheduleId: stage.id,
          description: `Stage ${stage.stage_no}: ${stage.name}`,
          amount: stage.amount,
          supplyKind: request.supplyKind,
          nature: request.nature,
        })),
      };
    },
  });

  const changed = (row: InvoiceRow, change: string) => ({
    type: 'billing.invoice.changed',
    payload: { invoiceId: row.id, projectId: row.project_id, status: row.status, change },
  });

  async function dtoOf(db: Db, row: InvoiceRow): Promise<InvoiceDto> {
    const state = await approvals.getApprovalState(db, invoiceDocType, row.id);
    return {
      ...headerOf(row),
      lines: (await listLines(db, row.id)).map((line) => ({
        lineNo: line.line_no,
        scheduleId: line.schedule_id,
        description: line.description,
        amount: line.amount,
        supplyKind: line.supply_kind,
        nature: line.nature,
      })),
      taxSnapshot: row.tax_snapshot,
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
      creditedBase: await issuedCreditBase(db, row.id),
    };
  }

  /** Locks the row, checks the caller reaches its project and that the version is current. */
  async function withLock(
    tx: Db,
    id: string,
    actor: Actor,
    expectedVersion: number,
  ): Promise<InvoiceRow> {
    const row = assertFound(await findInvoice(tx, id, true), 'invoice');
    assertProjectReachable(actor, row.project_id);
    if (expectedVersion !== row.version) assertUpdated(undefined);
    return row;
  }

  /** BR-3, BR-4: advance recovery, tax, gross total and expected withholding of an invoice. */
  async function figuresOf(
    db: Db,
    row: Pick<InvoiceRow, 'id' | 'project_id' | 'source_type' | 'invoice_date' | 'payment_days'>,
  ): Promise<InvoiceFigures> {
    const lines = await listLines(db, row.id);
    const project = await projects.getProject(db, row.project_id);
    const locationId = assertProjectHasLocation(project.locationId);
    const supplyKind = assertSingleSupplyKind(lines.map((line) => line.supply_kind)) as SupplyKind;
    const base = Money.of(scheduleTotal(lines)).toString();
    const atReceipt = (await setting(db, billingSettingKeys.taxOnAdvanceAtReceipt)) as boolean;

    let recovery = '0.00';
    if (row.source_type !== 'advance') {
      recovery = advanceRecovery({
        method: assertRecoveryMethod(
          (await setting(db, billingSettingKeys.recoveryMethod)) as string,
        ),
        unapplied: await unappliedAdvance(db, row.project_id),
        invoiceBase: base,
        remainingUnbilled: await schedule.plannedTotal(db, row.project_id),
        fixedPercent: (await setting(db, billingSettingKeys.fixedPercent)) as string,
      });
    }

    // Recovery that reduces the taxable base is taken from the lines before the engine rates them.
    const rated = spreadReduction(
      lines.map((line) => line.amount),
      atReceipt ? '0' : recovery,
    );
    const snapshot = await tax.calculateSalesTax(db, {
      locationId,
      supplyKind,
      date: row.invoice_date,
      lines: lines.map((line, index) => ({
        id: String(line.line_no),
        amount: rated[index] as string,
        nature: line.nature,
      })),
    });
    const withheld = await tax.calculateWithholding(db, {
      direction: 'client_withholds',
      authorityCode: snapshot.authorityCode,
      nature: lines[0]?.nature ?? '',
      date: row.invoice_date,
      invoiceTotal: snapshot.total,
      taxAmount: snapshot.taxTotal,
      base: snapshot.base,
    });
    const days =
      row.payment_days ?? ((await setting(db, billingSettingKeys.defaultPaymentDays)) as number);
    // The engine's base equals the taxable base when prices exclude tax; when they include tax it is
    // the net of the gross lines, and that net is what the invoice states.
    const taxable = snapshot.pricesIncludeTax
      ? snapshot.base
      : taxableBase(base, recovery, atReceipt);
    return {
      baseAmount: base,
      advanceRecovery: recovery,
      taxableBase: taxable,
      taxTotal: snapshot.taxTotal,
      grossTotal: grossTotal(taxable, snapshot.taxTotal, recovery, atReceipt),
      withholdingExpected: withheld
        .reduce((sum, rule) => sum.add(Money.of(rule.amount)), Money.zero())
        .toString(),
      taxOnAdvanceAtReceipt: atReceipt,
      authorityCode: snapshot.authorityCode,
      registrationNumber: snapshot.registrationNumber,
      dueDate: dueDateOf(row.invoice_date, days),
      snapshot,
    };
  }

  const figureColumns = (figures: InvoiceFigures) => ({
    base_amount: figures.baseAmount,
    advance_recovery: figures.advanceRecovery,
    taxable_base: figures.taxableBase,
    tax_total: figures.taxTotal,
    gross_total: figures.grossTotal,
    withholding_expected: figures.withholdingExpected,
    tax_on_advance_at_receipt: figures.taxOnAdvanceAtReceipt,
    authority_code: figures.authorityCode,
    registration_number: figures.registrationNumber,
    due_date: figures.dueDate,
    tax_snapshot: JSON.stringify(figures.snapshot),
  });

  /** BR-7: the invoice would not take the net billed above the contract value. */
  async function assertWithinContractValue(
    tx: Db,
    row: InvoiceRow,
    figures: InvoiceFigures,
    contractValue: string,
  ): Promise<void> {
    assertWithinContract({
      contractValue,
      netBilled: await netBilled(tx, row.project_id, COUNTED, row.id),
      adding: Money.of(figures.baseAmount).sub(Money.of(figures.advanceRecovery)).toString(),
    });
  }

  const writeLines = (tx: Db, invoiceId: string, lines: SourceLine[]) =>
    replaceLines(
      tx,
      invoiceId,
      lines.map((line, index) => ({
        id: newId(),
        lineNo: index + 1,
        scheduleId: line.scheduleId,
        description: line.description,
        amount: Money.of(line.amount).toString(),
        supplyKind: line.supplyKind,
        nature: line.nature,
      })),
    );

  /** BR-3: the recovery of an issued invoice is applied to the received advances, oldest first. */
  async function applyAdvance(tx: Db, row: InvoiceRow, actor: Actor, at: Date): Promise<void> {
    let left = Money.of(row.advance_recovery);
    for (const advance of await lockedAdvances(tx, row.project_id, 'asc')) {
      if (left.isZero()) break;
      const room = Money.of(advance.amount).sub(Money.of(advance.applied));
      if (!room.value.gt(0)) continue;
      const take = left.compare(room) < 0 ? left : room;
      const applied = Money.of(advance.applied).add(take);
      await updateAdvance(
        tx,
        advance.id,
        advance.version,
        {
          applied: applied.toString(),
          status: applied.equals(Money.of(advance.amount)) ? 'fully_applied' : 'received',
        },
        actor.userId,
        at,
      );
      left = left.sub(take);
    }
  }

  async function insertDraft(
    tx: Db,
    projectId: string,
    input: InvoiceInput,
    actor: Actor,
    sourceLines: { sourceType: InvoiceSourceType; lines: SourceLine[] },
  ): Promise<InvoiceDto> {
    const project = await projects.getProject(tx, projectId);
    assertProjectBillable(project.status);
    const base = Money.of(scheduleTotal(sourceLines.lines)).toString();
    const days =
      input.paymentDays ?? ((await setting(tx, billingSettingKeys.defaultPaymentDays)) as number);
    const id = newId();
    const row = await insertInvoice(
      tx,
      {
        id,
        source_type: sourceLines.sourceType,
        project_id: projectId,
        party_id: project.partyId,
        invoice_date: BusinessDate.parse(input.invoiceDate).toString(),
        due_date: dueDateOf(input.invoiceDate, days),
        base_amount: base,
        taxable_base: base,
        gross_total: base,
        payment_days: input.paymentDays ?? null,
        notes: textOrNull(input.notes),
      },
      actor.userId,
      clock.now(),
    );
    await writeLines(tx, id, sourceLines.lines);
    await record(tx, actor, {
      action: 'billing.invoice.create',
      entityType: 'bil_invoice',
      entityId: id,
      after: { status: row.status, sourceType: row.source_type, baseAmount: base },
      event: changed(row, 'created'),
    });
    return dtoOf(tx, row);
  }

  const requestFor = (projectId: string, input: InvoiceInput, exceptInvoiceId: string | null) => ({
    projectId,
    scheduleIds: input.scheduleIds,
    exceptInvoiceId,
    supplyKind: input.supplyKind ?? 'services',
    nature: textOrNull(input.nature),
  });

  return {
    registry,

    getInvoice: async (db, id) => dtoOf(db, assertFound(await findInvoice(db, id), 'invoice')),

    async listInvoicesForProject(db, projectId) {
      const { rows } = await searchInvoices(db, { projectId, limit: 1000, offset: 0 });
      return rows.map(headerOf);
    },

    getBilledAmount: (db, projectId) => netBilled(db, projectId, ['issued'], null),

    async getProjectBilling(db, projectId, asOf) {
      return billedAsOf(db, projectId, BusinessDate.parse(asOf).toString());
    },

    registerInvoiceSource: (type, provider) => registry.register(type, provider),

    async list(db, query, actor) {
      if (query.projectId !== undefined) assertProjectReachable(actor, query.projectId);
      const { rows, total } = await searchInvoices(db, query);
      return pageOf(rows.map(headerOf), total, query);
    },

    async get(db, id, actor) {
      const row = assertFound(await findInvoice(db, id), 'invoice');
      assertProjectReachable(actor, row.project_id);
      return dtoOf(db, row);
    },

    async create(projectId, input, actor, tx) {
      assertProjectReachable(actor, projectId);
      await schedule.sync(tx, projectId, actor);
      const provider = registry.resolve(input.source ?? 'project_stage');
      return insertDraft(
        tx,
        projectId,
        input,
        actor,
        await provider.buildLines(tx, requestFor(projectId, input, null)),
      );
    },

    async createAdvanceInvoice(projectId, input, actor, tx) {
      assertProjectReachable(actor, projectId);
      return insertDraft(
        tx,
        projectId,
        { scheduleIds: [], invoiceDate: input.invoiceDate, notes: input.notes },
        actor,
        {
          sourceType: 'advance',
          lines: [
            {
              scheduleId: null,
              description: 'Advance payment',
              amount: input.amount,
              supplyKind: 'services',
              nature: null,
            },
          ],
        },
      );
    },

    async update(id, input, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertEditable(existing.status as InvoiceStatus);
      // An advance invoice bills a stated amount; only its date, terms and notes change.
      const sourceLines =
        existing.source_type === 'advance'
          ? undefined
          : await registry
              .resolve(input.source ?? 'project_stage')
              .buildLines(tx, requestFor(existing.project_id, input, existing.id));
      const base = sourceLines === undefined ? undefined : scheduleTotal(sourceLines.lines);
      const row = assertUpdated(
        await updateInvoice(
          tx,
          id,
          expectedVersion,
          {
            invoice_date: BusinessDate.parse(input.invoiceDate).toString(),
            due_date: dueDateOf(
              input.invoiceDate,
              input.paymentDays ??
                ((await setting(tx, billingSettingKeys.defaultPaymentDays)) as number),
            ),
            payment_days: input.paymentDays ?? null,
            notes: textOrNull(input.notes),
            ...(sourceLines === undefined || base === undefined
              ? {}
              : {
                  source_type: sourceLines.sourceType,
                  base_amount: base,
                  taxable_base: base,
                  gross_total: base,
                }),
          },
          actor.userId,
          clock.now(),
        ),
      );
      if (sourceLines !== undefined) await writeLines(tx, id, sourceLines.lines);
      await record(tx, actor, {
        action: 'billing.invoice.update',
        entityType: 'bil_invoice',
        entityId: id,
        before: { baseAmount: existing.base_amount },
        after: { baseAmount: row.base_amount },
        event: changed(row, 'updated'),
      });
      return dtoOf(tx, row);
    },

    async preview(db, id, actor) {
      const row = assertFound(await findInvoice(db, id), 'invoice');
      assertProjectReachable(actor, row.project_id);
      return figuresOf(db, row);
    },

    async submit(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertTransition(existing.status as InvoiceStatus, 'pending_approval');
      const contractValue = await schedule.assertReadyToBill(tx, existing.project_id);
      const figures = await figuresOf(tx, existing);
      await assertWithinContractValue(tx, existing, figures, contractValue);
      const row = assertUpdated(
        await updateInvoice(
          tx,
          id,
          expectedVersion,
          { status: 'pending_approval', ...figureColumns(figures) },
          actor.userId,
          clock.now(),
        ),
      );
      await approvals.requestApproval(
        {
          docType: invoiceDocType,
          docId: id,
          amount: figures.grossTotal,
          requesterId: actor.userId,
          context: {
            projectId: row.project_id,
            sourceType: row.source_type,
            baseAmount: figures.baseAmount,
            taxTotal: figures.taxTotal,
            grossTotal: figures.grossTotal,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      await record(tx, actor, {
        action: 'billing.invoice.submit',
        entityType: 'bil_invoice',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, grossTotal: row.gross_total },
        event: changed(row, 'submitted'),
      });
      return dtoOf(tx, row);
    },

    async issue(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertTransition(existing.status as InvoiceStatus, 'issued');
      const contractValue = await schedule.assertReadyToBill(tx, existing.project_id);
      const figures = await figuresOf(tx, existing);
      assertFiguresUnchanged(
        covered({
          baseAmount: existing.base_amount,
          advanceRecovery: existing.advance_recovery,
          taxableBase: existing.taxable_base,
          taxTotal: existing.tax_total,
          grossTotal: existing.gross_total,
          withholdingExpected: existing.withholding_expected,
          taxOnAdvanceAtReceipt: existing.tax_on_advance_at_receipt,
        }),
        covered(figures),
      );
      await assertWithinContractValue(tx, existing, figures, contractValue);
      // BR-5: the number is taken now, in this transaction, never at draft.
      const seriesCode = invoiceSeriesFor(
        figures.authorityCode,
        (await platform.numbering.list(tx)).map((series) => series.code),
        invoiceSeries,
      );
      const number = await platform.numbering.next(seriesCode, tx);
      const at = clock.now();
      const row = assertUpdated(
        await updateInvoice(
          tx,
          id,
          expectedVersion,
          {
            status: 'issued',
            number,
            series_code: seriesCode,
            issued_at: at.toISOString(),
            ...figureColumns(figures),
          },
          actor.userId,
          at,
        ),
      );
      const lines = await listLines(tx, id);
      const stageIds = lines.flatMap((line) =>
        line.schedule_id === null ? [] : [line.schedule_id],
      );
      await setStagesStatus(tx, stageIds, 'invoiced', actor.userId, at);
      await applyAdvance(tx, row, actor, at);
      await record(tx, actor, {
        action: 'billing.invoice.issue',
        entityType: 'bil_invoice',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, number, grossTotal: row.gross_total },
        event: {
          type: 'invoice.issued',
          payload: {
            invoiceId: id,
            number,
            projectId: row.project_id,
            partyId: row.party_id,
            sourceType: row.source_type,
            authorityCode: row.authority_code,
            invoiceDate: row.invoice_date,
            dueDate: row.due_date,
            baseAmount: row.base_amount,
            advanceRecovery: row.advance_recovery,
            taxTotal: row.tax_total,
            grossTotal: row.gross_total,
            withholdingExpected: row.withholding_expected,
          },
        },
      });
      return dtoOf(tx, row);
    },

    async cancel(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertCancellableDirectly(existing.status as InvoiceStatus);
      assertTransition(existing.status as InvoiceStatus, 'cancelled');
      if (existing.status === 'pending_approval') {
        await approvals.cancelApproval(
          {
            docType: invoiceDocType,
            docId: id,
            reason: 'The invoice was cancelled',
            actorUserId: actor.userId,
            requestId: actor.requestId,
          },
          tx,
        );
      }
      const row = assertUpdated(
        await updateInvoice(
          tx,
          id,
          existing.version,
          { status: 'cancelled' },
          actor.userId,
          clock.now(),
        ),
      );
      const advance = await findAdvanceByInvoice(tx, id);
      if (advance !== undefined) {
        await updateAdvance(
          tx,
          advance.id,
          advance.version,
          { deleted_at: clock.now().toISOString() },
          actor.userId,
          clock.now(),
        );
      }
      await record(tx, actor, {
        action: 'billing.invoice.cancel',
        entityType: 'bil_invoice',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: {
          type: 'invoice.cancelled',
          payload: { invoiceId: id, projectId: row.project_id, by: 'cancel' },
        },
      });
      return dtoOf(tx, row);
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const row = await findInvoice(tx, payload.docId, true);
      if (row === undefined || row.status !== 'pending_approval') return;
      const to = outcome === 'approved' ? 'approved' : 'draft';
      assertTransition(row.status, to);
      const next = assertUpdated(
        await updateInvoice(tx, row.id, row.version, { status: to }, null, clock.now()),
      );
      await record(
        tx,
        { userId: null, requestId: null },
        {
          action: `billing.invoice.${outcome}`,
          entityType: 'bil_invoice',
          entityId: row.id,
          before: { status: row.status },
          after: { status: next.status },
          event: changed(next, outcome),
        },
      );
    },

    async printModel(db, id) {
      const row = assertFound(await findInvoice(db, id), 'invoice');
      const company = await masterData.company.getCompany(db);
      const party = assertFound(await masterData.getParty(db, row.party_id), 'party');
      const project = await projects.getProject(db, row.project_id);
      const registration =
        row.authority_code === null
          ? null
          : await masterData.getRegistration(db, row.authority_code, { date: row.invoice_date });
      const snapshot = row.tax_snapshot as {
        taxLines?: { taxCode: string; ratePercent: string; base: string; tax: string }[];
      } | null;
      return buildInvoicePrintModel({
        company: {
          name: company?.name ?? '',
          address: company?.address ?? null,
          phone: company?.phone ?? null,
          email: company?.email ?? null,
        },
        registration:
          registration === null
            ? null
            : {
                authority: registration.authority,
                registrationType: registration.registrationType,
                number: registration.number,
              },
        client: {
          name: party.name,
          address: party.address,
          city: party.city,
          ntn: party.ntn,
          strn: party.strn,
        },
        invoice: {
          number: row.number,
          status: row.status,
          invoiceDate: row.invoice_date,
          dueDate: row.due_date,
          projectName: project.name,
        },
        lines: (await listLines(db, id)).map((line) => ({
          description: line.description,
          amount: line.amount,
        })),
        baseAmount: row.base_amount,
        advanceRecovery: row.advance_recovery,
        taxOnAdvanceAtReceipt: row.tax_on_advance_at_receipt,
        taxableBase: row.taxable_base,
        taxGroups: (snapshot?.taxLines ?? []).map((group) => ({
          taxCode: group.taxCode,
          ratePercent: group.ratePercent,
          base: group.base,
          tax: group.tax,
        })),
        taxTotal: row.tax_total,
        grossTotal: row.gross_total,
        withholdingExpected: row.withholding_expected,
        paymentInstructions: (await setting(db, 'billing.payment_instructions')) as string,
      });
    },
  };
}
