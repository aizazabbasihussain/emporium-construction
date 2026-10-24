import type { Platform } from '../../platform/index.js';
import { approverIds } from '../policy/recipients.policy.js';
import type { ApprovalLookup, Db, UserDirectory } from '../types.js';
import type { NotificationsService } from './notifications.service.js';

interface ApprovalEventPayload {
  requestId: string;
  docType: string;
  docId: string;
  amount: string;
  requesterId: string;
}

/**
 * BR-10: `approval.*` events become notifications. The requester hears about progress and the
 * decision; holders of the next step's role hear that something waits for them.
 */
export function subscribeToApprovalEvents(deps: {
  platform: Platform;
  notifications: NotificationsService;
  directory: UserDirectory;
  getApprovalState: ApprovalLookup;
}): void {
  const { platform, notifications, directory, getApprovalState } = deps;

  const dataOf = (payload: ApprovalEventPayload) => ({
    requestId: payload.requestId,
    docType: payload.docType,
    docId: payload.docId,
    amount: payload.amount,
  });

  /** Tell the holders of the role the request now waits for; nothing if it has moved on. */
  async function notifyNextApprovers(payload: ApprovalEventPayload, tx: Db): Promise<void> {
    const state = await getApprovalState(tx, payload.docType, payload.docId);
    if (state.status !== 'pending' || !state.currentRole) return;
    const holders = await directory.usersWithRole(tx, state.currentRole);
    await notifications.notify(
      approverIds(holders, { requesterId: payload.requesterId, context: state.context }),
      'approval.requested',
      dataOf(payload),
      tx,
    );
  }

  const subscribe = (
    type: string,
    handle: (payload: ApprovalEventPayload, tx: Db) => Promise<void>,
  ) =>
    platform.events.subscribe(
      type,
      async (event, tx) => handle(event.payload as ApprovalEventPayload, tx),
      `notifications.${type}`,
    );

  subscribe('approval.requested', notifyNextApprovers);

  subscribe('approval.step_approved', async (payload, tx) => {
    await notifyNextApprovers(payload, tx);
    await notifications.notify([payload.requesterId], 'approval.progressed', dataOf(payload), tx);
  });

  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    subscribe(`approval.${outcome}`, async (payload, tx) => {
      await notifications.notify([payload.requesterId], `approval.${outcome}`, dataOf(payload), tx);
    });
  }
}
