// The only public entry point of the crm module.
import type { Clock } from '@emporium/domain/kernel';
import { crmNotificationTemplates, siteVisitEntityType } from '@emporium/shared';
import type { Files } from '../files/index.js';
import type { MasterData } from '../masterdata/index.js';
import type { Notifications } from '../notifications/index.js';
import type { Platform } from '../platform/index.js';
import { canAccessVisitFile } from './policy/crm.policy.js';
import { createCrmService, type CrmService } from './service/crm.service.js';

export interface Crm {
  service: CrmService;
  /** Query interface for other modules (spec P1-06 section 2). */
  getLead: CrmService['getLead'];
}

/**
 * Wires CRM on top of the kernel, master data, notifications and files. Registers the follow-up
 * reminder template and the access rule for site visit photos (BR-4, BR-7).
 */
export function createCrm(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masterData: Pick<MasterData, 'parties' | 'getParty' | 'listLocations'>;
  notifications: Pick<Notifications, 'scheduleReminder' | 'registerTemplate'>;
  files: Pick<Files, 'registerFileAccess'>;
}): Crm {
  for (const [code, key] of Object.entries(crmNotificationTemplates)) {
    deps.notifications.registerTemplate(code, key);
  }
  const service = createCrmService(deps);
  deps.files.registerFileAccess(siteVisitEntityType, async ({ actor, entityId, operation, db }) =>
    canAccessVisitFile({
      permissions: actor.permissions,
      operation,
      visitExists: await service.visitExists(db, entityId),
    }),
  );
  return { service, getLead: (db, id) => service.getLead(db, id) };
}

export { registerCrmRoutes, type CrmRouteDeps } from './routes/crm.routes.js';
export type {
  FollowUpDto,
  LeadDetailDto,
  LeadDto,
  PipelineDto,
  StageDto,
  VisitDto,
} from './types.js';
