import { Money } from '@emporium/domain/kernel';
import { isCertifiedStatus } from '@emporium/domain/subcontracts';
import { subcontractBillSource } from '@emporium/shared';
import { assertFound, assertProjectReachable } from '../policy/subcontracts.policy.js';
import { findWorkOrder, listCertificates, type WorkOrderRow } from '../repo/subcontracts.repo.js';
import type {
  Actor,
  CertificateStatus,
  Db,
  LedgerCertificateDto,
  SubcontractorStatementDto,
  WorkOrderLedgerDto,
  WorkOrderStatus,
} from '../types.js';
import type { Context } from './context.js';
import type { WorkOrderService } from './work-orders.service.js';
import { figuresOf } from './views.js';

export interface LedgerService {
  /** Contract, certified, billed and paid of one work order. */
  workOrderLedger(db: Db, id: string, actor: Actor): Promise<WorkOrderLedgerDto>;
  /** What a subcontractor has been ordered, certified, billed and paid across work orders. */
  statement(db: Db, partyId: string, actor: Actor): Promise<SubcontractorStatementDto>;
}

export function createLedgerService(ctx: Context, orders: WorkOrderService): LedgerService {
  const { payables } = ctx;

  async function figuresFor(db: Db, order: WorkOrderRow) {
    const figures = await figuresOf(db, order);
    const certificates: LedgerCertificateDto[] = [];
    let deductions = Money.zero();
    let billed = Money.zero();
    let paid = Money.zero();
    for (const row of (await listCertificates(db, order.id)).filter((c) =>
      isCertifiedStatus(c.status as CertificateStatus),
    )) {
      // Payments are allocated to the bill of a certificate, so only a billed one can be paid.
      const certificatePaid =
        row.status === 'billed'
          ? await payables.getPaidAmount(db, { type: subcontractBillSource, id: row.id })
          : '0.00';
      deductions = deductions.add(Money.of(row.deductions));
      if (row.status === 'billed') billed = billed.add(Money.of(row.net_certified));
      paid = paid.add(Money.of(certificatePaid));
      certificates.push({
        certificateId: row.id,
        number: row.number,
        status: row.status as CertificateStatus,
        gross: row.this_certificate_amount,
        deductions: row.deductions,
        net: row.net_certified,
        paid: Money.of(certificatePaid).toString(),
      });
    }
    return {
      totals: {
        contract: figures.current,
        certified: figures.certified,
        deductions: deductions.toString(),
        billed: billed.toString(),
        paid: paid.toString(),
      },
      certificates,
    };
  }

  return {
    async workOrderLedger(db, id, actor) {
      const order = assertFound(await findWorkOrder(db, id), 'work_order');
      assertProjectReachable(actor, order.project_id);
      const { totals, certificates } = await figuresFor(db, order);
      return {
        workOrderId: order.id,
        number: order.number,
        ...totals,
        committed: order.commitment_amount,
        certificates,
      };
    },

    async statement(db, partyId, actor) {
      const rows: SubcontractorStatementDto['orders'] = [];
      const totals = {
        contract: Money.zero(),
        certified: Money.zero(),
        deductions: Money.zero(),
        billed: Money.zero(),
        paid: Money.zero(),
      };
      for (const order of await orders.ordersOfParty(db, partyId, actor)) {
        const { totals: figures } = await figuresFor(db, order);
        rows.push({
          workOrderId: order.id,
          number: order.number,
          title: order.title,
          status: order.status as WorkOrderStatus,
          ...figures,
        });
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
          totals[key] = totals[key].add(Money.of(figures[key]));
        }
      }
      return {
        partyId,
        orders: rows,
        totals: {
          contract: totals.contract.toString(),
          certified: totals.certified.toString(),
          deductions: totals.deductions.toString(),
          billed: totals.billed.toString(),
          paid: totals.paid.toString(),
        },
      };
    },
  };
}
