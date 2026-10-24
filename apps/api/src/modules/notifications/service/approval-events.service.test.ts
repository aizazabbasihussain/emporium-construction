import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ESTIMATOR,
  OTHER_PROJECT,
  OWNER,
  PM,
  PM2,
  PROJECT,
  SUPERVISOR,
  SUPERVISOR_OTHER,
  createNotificationsKit,
  type NotificationsKit,
} from '../test-support.js';
import { subscribeToApprovalEvents } from './approval-events.service.js';
import type { Platform } from '../../platform/index.js';
import type { NotificationsService } from './notifications.service.js';

let kit: NotificationsKit;

beforeAll(async () => {
  kit = await createNotificationsKit();
  await kit.seedTestDoc();
}, 60_000);
afterAll(() => kit.close());

const request = (docType: string, docId: string, amount: string, context = {}) =>
  kit.db.transaction((tx) =>
    kit.approvals.requestApproval(
      { docType, docId, amount, requesterId: ESTIMATOR, context, requestId: null },
      tx,
    ),
  );

const act = (
  requestId: string,
  action: 'approve' | 'reject' | 'return',
  userId: string,
  roles: string[],
) =>
  kit.db.transaction((tx) =>
    kit.approvals.service.act(
      requestId,
      action,
      { comment: action === 'approve' ? null : 'see notes' },
      { userId, roles, scopes: [], requestId: null },
      tx,
    ),
  );

const templatesOf = async (userId: string, docId: string) =>
  (await kit.inboxOf(userId)).filter((n) => n.data.docId === docId).map((n) => n.template);

describe('approval events become notifications (AC-3, BR-10, T-6)', () => {
  it('notifies the step approvers on submission, exactly once, never the requester', async () => {
    const doc = kit.newDoc();
    await request('test_doc', doc, '150000');
    await kit.dispatch();
    await kit.dispatch();

    expect(await templatesOf(PM, doc)).toEqual(['approval.requested']);
    expect(await templatesOf(PM2, doc)).toEqual(['approval.requested']);
    expect(await templatesOf(OWNER, doc)).toEqual([]);
    expect(await templatesOf(ESTIMATOR, doc)).toEqual([]);
    const [item] = (await kit.inboxOf(PM)).filter((n) => n.data.docId === doc);
    expect(item?.data).toMatchObject({ docType: 'test_doc', amount: '150000.00' });
  });

  it('moves on: next approvers are told, the requester sees progress, then the decision', async () => {
    const doc = kit.newDoc();
    const created = await request('test_doc', doc, '150000');
    await kit.dispatch();

    await act(created.id, 'approve', PM, ['project_manager']);
    await kit.dispatch();
    expect(await templatesOf(OWNER, doc)).toEqual(['approval.requested']);
    expect(await templatesOf(ESTIMATOR, doc)).toEqual(['approval.progressed']);

    await act(created.id, 'approve', OWNER, ['management']);
    await kit.dispatch();
    await kit.dispatch();
    expect(await templatesOf(ESTIMATOR, doc)).toEqual(['approval.progressed', 'approval.approved']);
    expect(await templatesOf(OWNER, doc)).toEqual(['approval.requested']);
  });

  it.each([
    ['reject', 'approval.rejected'],
    ['return', 'approval.returned'],
  ] as const)('tells the requester about a %s', async (action, template) => {
    const doc = kit.newDoc();
    const created = await request('test_doc', doc, '50');
    await act(created.id, action, PM, ['project_manager']);
    await kit.dispatch();
    expect(await templatesOf(ESTIMATOR, doc)).toEqual([template]);
  });

  it('tells the requester about a cancellation', async () => {
    const doc = kit.newDoc();
    await request('test_doc', doc, '50');
    await kit.db.transaction((tx) =>
      kit.approvals.cancelApproval(
        { docType: 'test_doc', docId: doc, reason: 'withdrawn', actorUserId: PM },
        tx,
      ),
    );
    await kit.dispatch();
    expect(await templatesOf(ESTIMATOR, doc)).toEqual(['approval.cancelled']);
  });

  it('does not alert approvers when the request has already moved on by delivery time', async () => {
    const doc = kit.newDoc();
    const created = await request('test_doc', doc, '150000');
    await act(created.id, 'approve', PM, ['project_manager']);
    await act(created.id, 'approve', OWNER, ['management']);
    await kit.dispatch();
    expect(await templatesOf(PM, doc)).toEqual([]);
    expect(await templatesOf(OWNER, doc)).toEqual([]);
    expect(await templatesOf(ESTIMATOR, doc)).toEqual(['approval.progressed', 'approval.approved']);
  });

  it('limits scope-limited approvers to the project of the request', async () => {
    const doc = kit.newDoc();
    await request('site_doc', doc, '10', { scope: { type: 'project', id: PROJECT } });
    await kit.dispatch();
    expect(await templatesOf(SUPERVISOR, doc)).toEqual(['approval.requested']);
    expect(await templatesOf(SUPERVISOR_OTHER, doc)).toEqual([]);

    const other = kit.newDoc();
    await request('site_doc', other, '10', { scope: { type: 'project', id: OTHER_PROJECT } });
    await kit.dispatch();
    expect(await templatesOf(SUPERVISOR, other)).toEqual([]);
    expect(await templatesOf(SUPERVISOR_OTHER, other)).toEqual(['approval.requested']);
  });

  it('notifies nobody when no active user holds the step role', async () => {
    await kit.db.transaction((tx) =>
      kit.approvals.rules.replaceRules(
        'store_doc',
        {
          effectiveFrom: '2026-01-01',
          bands: [
            {
              minAmount: '0',
              maxAmount: null,
              steps: [{ stepNo: 1, roleCode: 'storekeeper', minApprovers: 1 }],
            },
          ],
        },
        { userId: OWNER, requestId: null },
        tx,
      ),
    );
    const doc = kit.newDoc();
    await request('store_doc', doc, '10');
    await kit.dispatch();
    for (const user of [PM, PM2, OWNER, ESTIMATOR, SUPERVISOR]) {
      expect(await templatesOf(user, doc)).toEqual([]);
    }
  });
});

describe('subscribeToApprovalEvents with a pending request that has no role', () => {
  it('sends no approver notification', async () => {
    const handlers = new Map<string, (event: unknown, tx: unknown) => Promise<void>>();
    const platform = {
      events: { subscribe: (type: string, handler: never) => handlers.set(type, handler) },
    } as unknown as Platform;
    const sent: unknown[] = [];
    const notifications = {
      notify: (...args: unknown[]) => {
        sent.push(args);
        return Promise.resolve(0);
      },
    } as unknown as NotificationsService;
    subscribeToApprovalEvents({
      platform,
      notifications,
      directory: { usersWithRole: () => Promise.reject(new Error('must not be called')) },
      getApprovalState: () => Promise.resolve({ status: 'pending', currentRole: null }),
    });
    const payload = { requestId: 'r', docType: 'd', docId: 'x', amount: '1', requesterId: 'u' };
    await handlers.get('approval.requested')?.({ payload }, {});
    expect(sent).toEqual([]);
    expect([...handlers.keys()].sort()).toEqual([
      'approval.approved',
      'approval.cancelled',
      'approval.rejected',
      'approval.requested',
      'approval.returned',
      'approval.step_approved',
    ]);
  });

  it('treats a request without context as unscoped', async () => {
    const handlers = new Map<string, (event: unknown, tx: unknown) => Promise<void>>();
    const platform = {
      events: { subscribe: (type: string, handler: never) => handlers.set(type, handler) },
    } as unknown as Platform;
    const sent: unknown[][] = [];
    const notifications = {
      notify: (...args: unknown[]) => {
        sent.push(args);
        return Promise.resolve(1);
      },
    } as unknown as NotificationsService;
    subscribeToApprovalEvents({
      platform,
      notifications,
      directory: {
        usersWithRole: () => Promise.resolve([{ id: 'a1', roles: ['x'], scopes: [] }]),
      },
      getApprovalState: () => Promise.resolve({ status: 'pending', currentRole: 'x' }),
    });
    const payload = { requestId: 'r', docType: 'd', docId: 'x', amount: '1', requesterId: 'u' };
    await handlers.get('approval.requested')?.({ payload }, {});
    expect(sent[0]?.[0]).toEqual(['a1']);
  });
});
