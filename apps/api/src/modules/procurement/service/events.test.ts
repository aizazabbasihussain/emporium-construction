import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MANAGEMENT,
  PROCUREMENT,
  createProcurementKit,
  type ProcurementKit,
} from '../test-support.js';
import { noGuards } from './context.js';

let kit: ProcurementKit;
beforeAll(async () => {
  kit = await createProcurementKit();
}, 120_000);
afterAll(() => kit.close());

describe('approval events of other documents', () => {
  it('are ignored by procurement', async () => {
    const po = await kit.approvedPo(null);
    const before = (await kit.procurement.getPurchaseOrder(kit.db, po)).version;
    await kit.db.transaction((tx) =>
      kit.approvals.requestApproval(
        { docType: 'expense', docId: kit.actor.userId, amount: '10.00', requesterId: PROCUREMENT },
        tx,
      ),
    );
    const state = await kit.approvals.getApprovalState(kit.db, 'expense', kit.actor.userId);
    if (state.status === 'none') throw new Error('no request');
    await kit.db.transaction((tx) =>
      kit.approvals.service.act(
        state.id,
        'approve',
        { comment: null },
        { userId: MANAGEMENT, roles: ['management'], scopes: [], requestId: null },
        tx,
      ),
    );
    await kit.platform.events.dispatchDue(kit.db);
    expect((await kit.procurement.getPurchaseOrder(kit.db, po)).version).toBe(before);
  });
});

describe('default receipt guards', () => {
  it('report that nothing was issued or billed until inventory and payables exist', async () => {
    expect(await noGuards.isIssued(kit.db, 'x')).toBe(false);
    expect(await noGuards.isBilled(kit.db, 'x')).toBe(false);
  });
});
