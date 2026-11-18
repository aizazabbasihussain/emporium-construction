import { Money, BusinessDate, type Clock } from '@emporium/domain/kernel';
import type { BillingAdvanceStatus } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import type { Variations } from '../../variations/index.js';
import {
  assertAdvanceInvoiceIssued,
  assertAdvanceRequested,
  assertFound,
  assertPositive,
  assertProjectBillable,
  assertProjectReachable,
  assertUpdated,
} from '../policy/billing.policy.js';
import {
  countInvoices,
  findAdvance,
  findInvoice,
  insertAdvance,
  listAdvances,
  netBilled,
  unappliedAdvance,
  updateAdvance,
  type AdvanceRow,
} from '../repo/billing.repo.js';
import type { Actor, AdvanceDto, BillingSummaryDto, Db, InvoiceDto } from '../types.js';
import type { InvoiceService } from './invoices.service.js';
import type { ScheduleService } from './schedule.service.js';
import { createRecorder, type Recorded } from './support.js';

export interface AdvanceService {
  /** BR-8: an advance request is an advance invoice for a stated amount plus its tracking row. */
  request(
    input: { projectId: string; amount: string; invoiceDate: string; notes?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<{ advance: AdvanceDto; invoice: InvoiceDto }>;
  /** BR-8: called by receipts (P2-04) when the money arrives; the advance becomes a customer credit. */
  markReceived(
    advanceId: string,
    receivedOn: string,
    by: Recorded & { userId: string },
    tx: Db,
  ): Promise<AdvanceDto>;
  list(db: Db, projectId: string, actor: Actor): Promise<AdvanceDto[]>;
  summary(db: Db, projectId: string, actor: Actor): Promise<BillingSummaryDto>;
}

export const advanceDto = (row: AdvanceRow): AdvanceDto => ({
  id: row.id,
  projectId: row.project_id,
  partyId: row.party_id,
  invoiceId: row.invoice_id,
  amount: row.amount,
  receivedOn: row.received_on,
  applied: row.applied,
  status: row.status as BillingAdvanceStatus,
  version: row.version,
});

export function createAdvanceService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject'>;
  variations: Pick<Variations, 'getCurrentContractValue'>;
  invoices: Pick<InvoiceService, 'createAdvanceInvoice'>;
  schedule: Pick<ScheduleService, 'plannedTotal'>;
}): AdvanceService {
  const { platform, clock, newId, projects, variations, invoices, schedule } = deps;
  const record = createRecorder(platform);

  return {
    async request(input, actor, tx) {
      assertPositive(input.amount, 'amount');
      assertProjectReachable(actor, input.projectId);
      const project = await projects.getProject(tx, input.projectId);
      assertProjectBillable(project.status);
      const amount = Money.of(input.amount).toString();
      const invoice = await invoices.createAdvanceInvoice(
        input.projectId,
        { amount, invoiceDate: input.invoiceDate, notes: input.notes },
        actor,
        tx,
      );
      const row = await insertAdvance(
        tx,
        {
          id: newId(),
          project_id: input.projectId,
          party_id: project.partyId,
          invoice_id: invoice.id,
          amount,
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'billing.advance.request',
        entityType: 'bil_advance',
        entityId: row.id,
        after: { amount, invoiceId: invoice.id },
        event: {
          type: 'billing.advance.changed',
          payload: { advanceId: row.id, projectId: row.project_id, status: row.status },
        },
      });
      return { advance: advanceDto(row), invoice };
    },

    async markReceived(advanceId, receivedOn, by, tx) {
      const existing = assertFound(await findAdvance(tx, advanceId, true), 'advance');
      assertAdvanceRequested(existing.status);
      const invoice = assertFound(
        existing.invoice_id === null ? undefined : await findInvoice(tx, existing.invoice_id),
        'invoice',
      );
      assertAdvanceInvoiceIssued(invoice.status);
      const row = assertUpdated(
        await updateAdvance(
          tx,
          advanceId,
          existing.version,
          { status: 'received', received_on: BusinessDate.parse(receivedOn).toString() },
          by.userId,
          clock.now(),
        ),
      );
      await record(tx, by, {
        action: 'billing.advance.receive',
        entityType: 'bil_advance',
        entityId: advanceId,
        before: { status: existing.status },
        after: { status: row.status, receivedOn: row.received_on },
        event: {
          type: 'billing.advance.changed',
          payload: { advanceId, projectId: row.project_id, status: row.status },
        },
      });
      return advanceDto(row);
    },

    async list(db, projectId, actor) {
      assertProjectReachable(actor, projectId);
      return (await listAdvances(db, projectId)).map(advanceDto);
    },

    async summary(db, projectId, actor) {
      assertProjectReachable(actor, projectId);
      const project = await projects.getProject(db, projectId);
      const contractValue = await variations.getCurrentContractValue(db, projectId);
      const billed = await netBilled(db, projectId, ['issued'], null);
      return {
        projectId,
        originalContractValue: project.originalContractValue,
        contractValue,
        netBilled: billed,
        remainingToBill: Money.of(contractValue).sub(Money.of(billed)).toString(),
        unappliedAdvance: await unappliedAdvance(db, projectId),
        plannedStages: await schedule.plannedTotal(db, projectId),
        invoices: await countInvoices(db, projectId),
        advances: (await listAdvances(db, projectId)).map(advanceDto),
      };
    },
  };
}
