import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../platform/index.js';
import { subscribeToApprovalOutcomes } from './approval-events.service.js';

type Handler = (event: { payload: unknown }, tx: unknown) => Promise<void>;

describe('approval outcome subscription', () => {
  const setup = () => {
    const handlers = new Map<string, Handler>();
    const platform = {
      events: {
        subscribe: (type: string, handler: Handler) => void handlers.set(type, handler),
      },
    } as unknown as Platform;
    const onApprovalOutcome = vi.fn().mockResolvedValue(undefined);
    subscribeToApprovalOutcomes({ platform, quotations: { onApprovalOutcome } });
    return { handlers, onApprovalOutcome };
  };

  it('listens to every final outcome', () => {
    expect([...setup().handlers.keys()].sort()).toEqual([
      'approval.approved',
      'approval.cancelled',
      'approval.rejected',
      'approval.returned',
    ]);
  });

  it('passes quotation events on and ignores the other document types', async () => {
    const { handlers, onApprovalOutcome } = setup();
    const tx = {};
    const payload = { docType: 'quotation', docId: 'q1', requesterId: 'u1' };
    await (handlers.get('approval.rejected') as Handler)({ payload }, tx);
    expect(onApprovalOutcome).toHaveBeenCalledWith('rejected', payload, tx);
    await (handlers.get('approval.approved') as Handler)(
      { payload: { ...payload, docType: 'purchase_order' } },
      tx,
    );
    expect(onApprovalOutcome).toHaveBeenCalledTimes(1);
  });
});
