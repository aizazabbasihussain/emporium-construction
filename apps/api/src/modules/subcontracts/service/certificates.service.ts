import { BACK_CHARGE_DOC_TYPE } from '@emporium/domain/costing';
import { BusinessDate } from '@emporium/domain/kernel';
import {
  assertCertificateTransition,
  billBase,
  certificateFigures,
  certificationEntries,
  deductionsOf,
  isFullyCertified,
  normalizeBackChargeAmount,
  remainingCommitment,
  type CertificateFigures,
} from '@emporium/domain/subcontracts';
import {
  subcontractBillSource,
  subcontractCertificateDocType,
  subcontractCertificateSeries,
} from '@emporium/shared';
import type { RequestDto } from '../../approvals/index.js';
import type { BillDto, BillSourceProvider } from '../../payables/index.js';
import {
  assertApplied,
  assertBillable,
  assertChargeEditable,
  assertCostCodeActive,
  assertDraft,
  assertFound,
  assertLinkable,
  assertNoOpenCertificate,
  assertOrderActive,
  assertProjectReachable,
  assertRecoveryCode,
  assertUpdated,
  canSeeAmounts,
} from '../policy/subcontracts.policy.js';
import {
  certificateCounts,
  findBackCharge,
  findCertificate,
  findWorkOrder,
  insertBackCharge,
  insertCertificate,
  listBackChargesOfCertificate,
  listBackChargesOfOrder,
  listCertificates,
  softDeleteBackCharge,
  updateBackCharge,
  updateCertificate,
  type BackChargeRow,
  type CertificateRow,
  type WorkOrderRow,
} from '../repo/subcontracts.repo.js';
import type {
  Actor,
  BackChargeDto,
  CertificateBasis,
  CertificateDto,
  CertificateStatus,
  Db,
} from '../types.js';
import type { Context } from './context.js';
import { requiredText, textOrNull } from './support.js';
import type { WorkOrderService } from './work-orders.service.js';
import { certificateDtoOf, chargeDtoOf, figuresOf } from './views.js';

export interface CertificateInput {
  certificateDate: string;
  basis: CertificateBasis;
  cumulativePercent?: string | undefined;
  cumulativeAmount?: string | undefined;
  notes?: string | undefined;
}

export interface BackChargeInput {
  description: string;
  amount: string;
  recoversCost?: boolean | undefined;
  costCodeId?: string | undefined;
  /** A draft certificate of the same work order, or none. */
  certificateId?: string | null | undefined;
}

export interface BillInput {
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
  notes?: string | undefined;
}

export interface CertificateService {
  list(db: Db, workOrderId: string, actor: Actor): Promise<CertificateDto[]>;
  get(db: Db, id: string, actor: Actor): Promise<CertificateDto>;
  create(
    workOrderId: string,
    input: CertificateInput,
    actor: Actor,
    tx: Db,
  ): Promise<CertificateDto>;
  update(
    id: string,
    input: CertificateInput & { version: number },
    actor: Actor,
    tx: Db,
  ): Promise<CertificateDto>;
  submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<CertificateDto>;
  cancel(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<CertificateDto>;
  /** BR-5: a certified certificate becomes a payables bill. */
  bill(
    id: string,
    input: BillInput,
    actor: Actor,
    tx: Db,
  ): Promise<{ certificate: CertificateDto; bill: BillDto }>;
  listBackCharges(db: Db, workOrderId: string, actor: Actor): Promise<BackChargeDto[]>;
  addBackCharge(
    workOrderId: string,
    input: BackChargeInput,
    actor: Actor,
    tx: Db,
  ): Promise<BackChargeDto>;
  updateBackCharge(
    id: string,
    input: BackChargeInput & { version: number },
    actor: Actor,
    tx: Db,
  ): Promise<BackChargeDto>;
  removeBackCharge(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  onApprovalOutcome(
    outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
    payload: { docId: string },
    tx: Db,
  ): Promise<void>;
  /** What payables asks of a bill source (BR-5). */
  provider: BillSourceProvider;
}

export function createCertificateService(
  ctx: Context,
  orders: WorkOrderService,
): CertificateService {
  const { platform, clock, newId, projects, masterData, approvals, payables, record } = ctx;

  const changed = (row: CertificateRow, projectId: string, change: string) => ({
    type: 'subcontracts.certificate.changed',
    payload: {
      certificateId: row.id,
      workOrderId: row.work_order_id,
      projectId,
      number: row.number,
      status: row.status,
      change,
    },
  });

  const summaryOf = (row: CertificateRow) => ({
    number: row.number,
    status: row.status,
    cumulative: row.cumulative_amount,
    gross: row.this_certificate_amount,
    deductions: row.deductions,
    net: row.net_certified,
  });

  async function dtoOf(db: Db, row: CertificateRow, actor: Actor): Promise<CertificateDto> {
    return certificateDtoOf(
      row,
      await listBackChargesOfCertificate(db, row.id),
      await approvals.getApprovalState(db, subcontractCertificateDocType, row.id),
      canSeeAmounts(actor.permissions),
    );
  }

  async function lockedCertificate(
    tx: Db,
    id: string,
    actor: Actor,
    expectedVersion?: number,
  ): Promise<{ row: CertificateRow; order: WorkOrderRow }> {
    const row = assertFound(await findCertificate(tx, id, true), 'certificate');
    const order = assertFound(await findWorkOrder(tx, row.work_order_id, true), 'work_order');
    assertProjectReachable(actor, order.project_id);
    if (expectedVersion !== undefined && expectedVersion !== row.version) assertUpdated(undefined);
    return { row, order };
  }

  /** BR-2 and BR-3: the figures of a certificate against the current contract. */
  async function figuresFor(
    tx: Db,
    order: WorkOrderRow,
    input: Pick<CertificateInput, 'basis' | 'cumulativePercent' | 'cumulativeAmount'>,
    deductions: string,
  ): Promise<CertificateFigures> {
    const figures = await figuresOf(tx, order);
    return certificateFigures({
      basis: input.basis,
      contractAmount: figures.current,
      previousCumulative: figures.certified,
      cumulativePercent: input.cumulativePercent,
      cumulativeAmount: input.cumulativeAmount,
      deductions,
    });
  }

  const valuesOf = (figures: CertificateFigures) => ({
    cumulative_percent: figures.cumulativePercent,
    cumulative_amount: figures.cumulativeAmount,
    this_certificate_amount: figures.thisCertificateAmount,
    deductions: figures.deductions,
    net_certified: figures.netCertified,
  });

  /** BR-3: a draft certificate takes its deductions from the back-charges linked to it. */
  async function refresh(tx: Db, row: CertificateRow, by: string): Promise<CertificateRow> {
    const order = assertFound(await findWorkOrder(tx, row.work_order_id, true), 'work_order');
    const deductions = deductionsOf(
      (await listBackChargesOfCertificate(tx, row.id)).map((charge) => charge.amount),
    );
    const figures = await figuresFor(
      tx,
      order,
      {
        basis: row.basis as CertificateBasis,
        cumulativePercent: row.cumulative_percent,
        cumulativeAmount: row.cumulative_amount,
      },
      deductions,
    );
    return assertUpdated(
      await updateCertificate(tx, row.id, row.version, valuesOf(figures), by, clock.now()),
    );
  }

  async function moveTo(
    tx: Db,
    row: CertificateRow,
    to: CertificateStatus,
    values: Record<string, unknown>,
    by: string | null,
  ): Promise<CertificateRow> {
    assertCertificateTransition(row.status as CertificateStatus, to);
    return assertUpdated(
      await updateCertificate(tx, row.id, row.version, { status: to, ...values }, by, clock.now()),
    );
  }

  const postApproved = (
    tx: Db,
    order: WorkOrderRow,
    input: {
      costCodeId: string;
      amount: string;
      docType: string;
      docId: string;
      key: string;
      description: string;
    },
  ) =>
    projects.postCost(
      {
        costObject: { type: 'project', id: order.project_id },
        costCodeId: input.costCodeId,
        amount: input.amount,
        status: 'approved',
        sourceModule: 'subcontracts',
        sourceDocType: input.docType,
        sourceDocId: input.docId,
        entryDate: ctx.today(),
        description: input.description,
        idempotencyKey: input.key,
        actorUserId: null,
      },
      tx,
    );

  const service: CertificateService = {
    async list(db, workOrderId, actor) {
      const order = assertFound(await findWorkOrder(db, workOrderId), 'work_order');
      assertProjectReachable(actor, order.project_id);
      const items: CertificateDto[] = [];
      for (const row of await listCertificates(db, workOrderId)) {
        items.push(await dtoOf(db, row, actor));
      }
      return items;
    },

    async get(db, id, actor) {
      const row = assertFound(await findCertificate(db, id), 'certificate');
      const order = assertFound(await findWorkOrder(db, row.work_order_id), 'work_order');
      assertProjectReachable(actor, order.project_id);
      return dtoOf(db, row, actor);
    },

    async create(workOrderId, input, actor, tx) {
      const order = assertFound(await findWorkOrder(tx, workOrderId, true), 'work_order');
      assertProjectReachable(actor, order.project_id);
      assertOrderActive(order.status);
      assertNoOpenCertificate(await certificateCounts(tx, workOrderId));
      const figures = await figuresFor(tx, order, input, '0.00');
      const row = await insertCertificate(
        tx,
        {
          id: newId(),
          number: await platform.numbering.next(subcontractCertificateSeries, tx),
          work_order_id: workOrderId,
          certificate_date: BusinessDate.parse(input.certificateDate).toString(),
          basis: input.basis,
          notes: textOrNull(input.notes),
          ...valuesOf(figures),
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'subcontracts.certificate.create',
        entityType: 'sub_certificate',
        entityId: row.id,
        after: summaryOf(row),
        event: changed(row, order.project_id, 'created'),
      });
      return dtoOf(tx, row, actor);
    },

    async update(id, input, actor, tx) {
      const { row: existing, order } = await lockedCertificate(tx, id, actor, input.version);
      assertDraft(existing.status, 'certificate');
      const deductions = deductionsOf(
        (await listBackChargesOfCertificate(tx, id)).map((charge) => charge.amount),
      );
      const figures = await figuresFor(tx, order, input, deductions);
      const row = assertUpdated(
        await updateCertificate(
          tx,
          id,
          input.version,
          {
            certificate_date: BusinessDate.parse(input.certificateDate).toString(),
            basis: input.basis,
            notes: textOrNull(input.notes),
            ...valuesOf(figures),
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'subcontracts.certificate.update',
        entityType: 'sub_certificate',
        entityId: id,
        before: summaryOf(existing),
        after: summaryOf(row),
        event: changed(row, order.project_id, 'updated'),
      });
      return dtoOf(tx, row, actor);
    },

    async submit(id, expectedVersion, actor, tx) {
      const { row: existing, order } = await lockedCertificate(tx, id, actor, expectedVersion);
      assertCertificateTransition(existing.status as CertificateStatus, 'pending_approval');
      assertOrderActive(order.status);
      // The contract may have changed since the draft: the figures are worked out again.
      const fresh = await refresh(tx, existing, actor.userId);
      await approvals.requestApproval(
        {
          docType: subcontractCertificateDocType,
          docId: id,
          amount: fresh.this_certificate_amount,
          requesterId: actor.userId,
          context: {
            number: fresh.number,
            workOrderId: order.id,
            workOrderNumber: order.number,
            projectId: order.project_id,
            cumulativeAmount: fresh.cumulative_amount,
            thisCertificateAmount: fresh.this_certificate_amount,
            deductions: fresh.deductions,
            netCertified: fresh.net_certified,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      const row = await moveTo(tx, fresh, 'pending_approval', {}, actor.userId);
      await record(tx, actor, {
        action: 'subcontracts.certificate.submit',
        entityType: 'sub_certificate',
        entityId: id,
        before: { status: existing.status },
        after: summaryOf(row),
        event: changed(row, order.project_id, 'submitted'),
      });
      return dtoOf(tx, row, actor);
    },

    async cancel(id, expectedVersion, actor, tx) {
      const { row: existing, order } = await lockedCertificate(tx, id, actor, expectedVersion);
      assertCertificateTransition(existing.status as CertificateStatus, 'cancelled');
      if (existing.status === 'pending_approval') {
        await approvals.cancelApproval(
          {
            docType: subcontractCertificateDocType,
            docId: id,
            reason: 'The certificate was cancelled',
            actorUserId: actor.userId,
            requestId: actor.requestId,
          },
          tx,
        );
      }
      // Its back-charges are free again for the next certificate.
      for (const charge of await listBackChargesOfCertificate(tx, id)) {
        assertUpdated(
          await updateBackCharge(
            tx,
            charge.id,
            charge.version,
            { certificate_id: null },
            actor.userId,
            clock.now(),
          ),
        );
      }
      const row = await moveTo(tx, existing, 'cancelled', {}, actor.userId);
      await record(tx, actor, {
        action: 'subcontracts.certificate.cancel',
        entityType: 'sub_certificate',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, order.project_id, 'cancelled'),
      });
      return dtoOf(tx, row, actor);
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const existing = await findCertificate(tx, payload.docId, true);
      if (
        existing === undefined ||
        existing.status !== 'pending_approval' ||
        outcome === 'cancelled'
      ) {
        return;
      }
      const system = { userId: null, requestId: null };
      const order = assertFound(
        await findWorkOrder(tx, existing.work_order_id, true),
        'work_order',
      );
      if (outcome !== 'approved') {
        const row = await moveTo(tx, existing, 'draft', {}, null);
        await record(tx, system, {
          action: `subcontracts.certificate.${outcome}`,
          entityType: 'sub_certificate',
          entityId: row.id,
          before: { status: existing.status },
          after: { status: row.status },
          event: changed(row, order.project_id, outcome),
        });
        return;
      }
      // BR-4: the status change is the guard, so the cost entries are posted exactly once.
      const state = (await approvals.getApprovalState(
        tx,
        subcontractCertificateDocType,
        existing.id,
      )) as RequestDto;
      const approver = (
        state.actions
          .filter((action) => action.action === 'approve')
          .at(-1) as RequestDto['actions'][number]
      ).actorId;
      const charges = await listBackChargesOfCertificate(tx, existing.id);
      const entries = certificationEntries({
        grossAmount: existing.this_certificate_amount,
        costCodeId: order.cost_code_id,
        backCharges: charges.map((charge) => ({
          id: charge.id,
          amount: charge.amount,
          recoversCost: charge.recovers_cost,
          costCodeId: charge.cost_code_id,
        })),
      });
      const gross = await postApproved(tx, order, {
        costCodeId: entries.gross.costCodeId,
        amount: entries.gross.amount,
        docType: 'subcontract_certificate',
        docId: existing.id,
        key: `subcontract:cert:${existing.id}:gross`,
        description: `Certificate ${existing.number} of work order ${order.number}`,
      });
      for (const recovery of entries.recoveries) {
        const charge = charges.find((c) => c.id === recovery.backChargeId) as BackChargeRow;
        const entry = await postApproved(tx, order, {
          costCodeId: recovery.costCodeId,
          amount: recovery.amount,
          docType: BACK_CHARGE_DOC_TYPE,
          docId: charge.id,
          key: `subcontract:cert:${existing.id}:recovery:${charge.id}`,
          description: `Back-charge on work order ${order.number}: ${charge.description}`,
        });
        assertUpdated(
          await updateBackCharge(
            tx,
            charge.id,
            charge.version,
            { entry_id: entry.id },
            null,
            clock.now(),
          ),
        );
      }
      const row = await moveTo(
        tx,
        existing,
        'certified',
        { gross_entry_id: gross.id, certified_by: approver, certified_on: ctx.today() },
        null,
      );
      // BR-4: the commitment falls by what is certified; BR-6: a fully certified order is complete.
      const figures = await figuresOf(tx, order);
      const remaining = remainingCommitment(figures.current, figures.certified);
      const recommitted = await orders.recommit(tx, order, remaining, null);
      if (isFullyCertified(figures.current, figures.certified)) {
        await orders.complete(tx, recommitted, null);
      }
      await record(tx, system, {
        action: 'subcontracts.certificate.approved',
        entityType: 'sub_certificate',
        entityId: row.id,
        before: { status: existing.status },
        after: { ...summaryOf(row), committed: remaining },
        event: {
          type: 'subcontract.certified',
          payload: {
            certificateId: row.id,
            workOrderId: order.id,
            projectId: order.project_id,
            partyId: order.party_id,
            number: row.number,
            cumulativeAmount: row.cumulative_amount,
            grossAmount: row.this_certificate_amount,
            deductions: row.deductions,
            netCertified: row.net_certified,
            committedAmount: remaining,
          },
        },
      });
    },

    async bill(id, input, actor, tx) {
      const { row: existing, order } = await lockedCertificate(tx, id, actor);
      let live = false;
      if (existing.bill_id !== null) {
        live = (await payables.bills.get(tx, existing.bill_id)).status !== 'cancelled';
      }
      assertBillable(existing.status, live);
      billBase(existing.net_certified);
      const bill = await payables.bills.createFromSource(
        subcontractBillSource,
        id,
        {
          vendorInvoiceNo: requiredText(input.vendorInvoiceNo, 'vendor_invoice_no'),
          billDate: input.billDate,
          dueDate: input.dueDate,
          notes: input.notes,
        },
        actor,
        tx,
      );
      const row = assertUpdated(
        await updateCertificate(
          tx,
          id,
          existing.version,
          { bill_id: bill.id },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'subcontracts.certificate.bill',
        entityType: 'sub_certificate',
        entityId: id,
        after: { billId: bill.id, billNumber: bill.number, net: row.net_certified },
        event: changed(row, order.project_id, 'bill_created'),
      });
      return { certificate: await dtoOf(tx, row, actor), bill };
    },

    async listBackCharges(db, workOrderId, actor) {
      const order = assertFound(await findWorkOrder(db, workOrderId), 'work_order');
      assertProjectReachable(actor, order.project_id);
      const visible = canSeeAmounts(actor.permissions);
      return (await listBackChargesOfOrder(db, workOrderId)).map((row) =>
        chargeDtoOf(row, visible),
      );
    },

    async addBackCharge(workOrderId, input, actor, tx) {
      const order = assertFound(await findWorkOrder(tx, workOrderId, true), 'work_order');
      assertProjectReachable(actor, order.project_id);
      assertOrderActive(order.status);
      const values = await chargeValues(tx, input);
      const certificate = await linkedCertificate(tx, input.certificateId, workOrderId);
      const row = await insertBackCharge(
        tx,
        {
          id: newId(),
          work_order_id: workOrderId,
          certificate_id: certificate?.id ?? null,
          ...values,
        },
        actor.userId,
        clock.now(),
      );
      if (certificate !== undefined) await refresh(tx, certificate, actor.userId);
      await record(tx, actor, {
        action: 'subcontracts.back_charge.create',
        entityType: 'sub_back_charge',
        entityId: row.id,
        after: { workOrder: order.number, amount: row.amount, recoversCost: row.recovers_cost },
        event: {
          type: 'subcontracts.back_charge.changed',
          payload: { backChargeId: row.id, workOrderId, change: 'created' },
        },
      });
      return chargeDtoOf(row, canSeeAmounts(actor.permissions));
    },

    async updateBackCharge(id, input, actor, tx) {
      const existing = assertFound(await findBackCharge(tx, id, true), 'back_charge');
      const order = assertFound(
        await findWorkOrder(tx, existing.work_order_id, true),
        'work_order',
      );
      assertProjectReachable(actor, order.project_id);
      const before = await chargeCertificate(tx, existing);
      assertChargeEditable(before?.status ?? null);
      const values = await chargeValues(tx, input);
      const after = await linkedCertificate(tx, input.certificateId, order.id);
      const row = assertUpdated(
        await updateBackCharge(
          tx,
          id,
          input.version,
          { certificate_id: after?.id ?? null, ...values },
          actor.userId,
          clock.now(),
        ),
      );
      for (const certificate of new Set([before, after])) {
        if (certificate !== undefined) {
          await refresh(
            tx,
            assertFound(await findCertificate(tx, certificate.id, true), 'certificate'),
            actor.userId,
          );
        }
      }
      await record(tx, actor, {
        action: 'subcontracts.back_charge.update',
        entityType: 'sub_back_charge',
        entityId: id,
        before: { amount: existing.amount, certificateId: existing.certificate_id },
        after: { amount: row.amount, certificateId: row.certificate_id },
        event: {
          type: 'subcontracts.back_charge.changed',
          payload: { backChargeId: id, workOrderId: order.id, change: 'updated' },
        },
      });
      return chargeDtoOf(row, canSeeAmounts(actor.permissions));
    },

    async removeBackCharge(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findBackCharge(tx, id, true), 'back_charge');
      const order = assertFound(
        await findWorkOrder(tx, existing.work_order_id, true),
        'work_order',
      );
      assertProjectReachable(actor, order.project_id);
      const certificate = await chargeCertificate(tx, existing);
      assertChargeEditable(certificate?.status ?? null);
      assertApplied(await softDeleteBackCharge(tx, id, expectedVersion, actor.userId, clock.now()));
      if (certificate !== undefined) await refresh(tx, certificate, actor.userId);
      await record(tx, actor, {
        action: 'subcontracts.back_charge.delete',
        entityType: 'sub_back_charge',
        entityId: id,
        before: { amount: existing.amount, certificateId: existing.certificate_id },
        event: {
          type: 'subcontracts.back_charge.changed',
          payload: { backChargeId: id, workOrderId: order.id, change: 'deleted' },
        },
      });
    },

    provider: {
      async buildBill(db, certificateId) {
        const certificate = assertFound(await findCertificate(db, certificateId), 'certificate');
        const order = assertFound(await findWorkOrder(db, certificate.work_order_id), 'work_order');
        const project = await projects.getProject(db, order.project_id);
        return {
          vendorPartyId: order.party_id,
          supplyKind: 'services',
          nature: 'subcontract',
          locationId: project.locationId ?? undefined,
          lines: [
            {
              description: `Work order ${order.number}, certificate ${certificate.number}`,
              quantity: '1',
              rate: billBase(certificate.net_certified),
              costObject: { type: 'project', id: order.project_id },
              costCodeId: order.cost_code_id,
              sourceEntryId: certificate.gross_entry_id as string,
            },
          ],
        };
      },

      async onPosted(tx, { billId, sourceDocId }) {
        const existing = await findCertificate(tx, sourceDocId, true);
        if (existing === undefined || existing.status !== 'certified') return;
        const order = assertFound(await findWorkOrder(tx, existing.work_order_id), 'work_order');
        // BR-4 and BR-5: posting the bill confirms the cost; the recoveries follow the gross cost.
        for (const charge of await listBackChargesOfCertificate(tx, existing.id)) {
          if (charge.entry_id === null) continue;
          const posted = await projects.transitionCost(charge.entry_id, 'posted', tx, null);
          assertUpdated(
            await updateBackCharge(
              tx,
              charge.id,
              charge.version,
              { entry_id: posted.id },
              null,
              clock.now(),
            ),
          );
        }
        const row = await moveTo(tx, existing, 'billed', { bill_id: billId }, null);
        await record(
          tx,
          { userId: null, requestId: null },
          {
            action: 'subcontracts.certificate.billed',
            entityType: 'sub_certificate',
            entityId: row.id,
            before: { status: existing.status },
            after: { status: row.status, billId },
            event: changed(row, order.project_id, 'billed'),
          },
        );
      },

      async onCancelled(tx, { billId, sourceDocId, reason }) {
        const existing = await findCertificate(tx, sourceDocId, true);
        if (existing === undefined || existing.status !== 'billed') return;
        const order = assertFound(await findWorkOrder(tx, existing.work_order_id), 'work_order');
        // Payables reversed the posted gross cost: it is approved cost again, like a cancelled receipt.
        const gross = await postApproved(tx, order, {
          costCodeId: order.cost_code_id,
          amount: existing.this_certificate_amount,
          docType: 'subcontract_certificate',
          docId: existing.id,
          key: `subcontract:cert:${existing.id}:gross:${billId}`,
          description: `Certificate ${existing.number} of work order ${order.number} (bill cancelled)`,
        });
        for (const charge of await listBackChargesOfCertificate(tx, existing.id)) {
          if (charge.entry_id === null) continue;
          await projects.reverseCost(charge.entry_id, `Bill cancelled: ${reason}`, tx, null);
          const entry = await postApproved(tx, order, {
            costCodeId: charge.cost_code_id as string,
            amount: `-${charge.amount}`,
            docType: BACK_CHARGE_DOC_TYPE,
            docId: charge.id,
            key: `subcontract:cert:${existing.id}:recovery:${charge.id}:${billId}`,
            description: `Back-charge on work order ${order.number}: ${charge.description}`,
          });
          assertUpdated(
            await updateBackCharge(
              tx,
              charge.id,
              charge.version,
              { entry_id: entry.id },
              null,
              clock.now(),
            ),
          );
        }
        const row = await moveTo(
          tx,
          existing,
          'certified',
          { bill_id: null, gross_entry_id: gross.id },
          null,
        );
        await record(
          tx,
          { userId: null, requestId: null },
          {
            action: 'subcontracts.certificate.unbilled',
            entityType: 'sub_certificate',
            entityId: row.id,
            before: { status: existing.status, billId },
            after: { status: row.status, reason },
            event: changed(row, order.project_id, 'unbilled'),
          },
        );
      },
    },
  };

  /** BR-3: the back-charge values; a recovery names its cost code. */
  async function chargeValues(tx: Db, input: BackChargeInput) {
    const recoversCost = input.recoversCost ?? false;
    assertRecoveryCode(recoversCost, input.costCodeId);
    if (input.costCodeId !== undefined) {
      assertCostCodeActive((await masterData.getCostCode(tx, input.costCodeId)).active);
    }
    return {
      description: requiredText(input.description, 'description'),
      amount: normalizeBackChargeAmount(input.amount),
      recovers_cost: recoversCost,
      cost_code_id: input.costCodeId ?? null,
    };
  }

  /** The draft certificate a back-charge is linked to, or undefined when it stays unlinked. */
  async function linkedCertificate(
    tx: Db,
    certificateId: string | null | undefined,
    workOrderId: string,
  ): Promise<CertificateRow | undefined> {
    if (certificateId === null || certificateId === undefined) return undefined;
    const certificate = await findCertificate(tx, certificateId, true);
    assertLinkable(certificate, workOrderId);
    return certificate;
  }

  /** The certificate a stored back-charge is linked to. */
  async function chargeCertificate(
    tx: Db,
    charge: BackChargeRow,
  ): Promise<CertificateRow | undefined> {
    return charge.certificate_id === null
      ? undefined
      : await findCertificate(tx, charge.certificate_id, true);
  }

  return service;
}
