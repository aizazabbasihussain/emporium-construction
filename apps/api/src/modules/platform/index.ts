// The only public entry point of the platform module.
import { uuidv7, type IdGenerator } from './ids.js';
import { createAuditService, type AuditService } from './service/audit.service.js';
import { createBackdatingService, type BackdatingService } from './service/backdating.service.js';
import { createEventsService, type EventsService } from './service/events.service.js';
import {
  createIdempotencyService,
  type IdempotencyService,
} from './service/idempotency.service.js';
import { createNumberingService, type NumberingService } from './service/numbering.service.js';
import { createSettingsService, type SettingsService } from './service/settings.service.js';
import type { Clock } from '@emporium/domain/kernel';

export interface Platform {
  audit: AuditService;
  numbering: NumberingService;
  events: EventsService;
  idempotency: IdempotencyService;
  settings: SettingsService;
  backdating: BackdatingService;
}

/** Wires the kernel services. Other modules receive the returned object, never the internals. */
export function createPlatform(deps: { clock: Clock; newId?: IdGenerator }): Platform {
  const newId = deps.newId ?? (() => uuidv7(deps.clock.now()));
  const audit = createAuditService({ newId });
  const settings = createSettingsService({ audit });
  return {
    audit,
    settings,
    numbering: createNumberingService({ clock: deps.clock, audit }),
    events: createEventsService({ clock: deps.clock, newId }),
    idempotency: createIdempotencyService(),
    backdating: createBackdatingService({ clock: deps.clock, settings, audit }),
  };
}

export { registerPlatformRoutes, type PlatformRouteDeps } from './routes/admin.routes.js';
export { uuidv7, type IdGenerator } from './ids.js';
export type { Principal, Db } from './types.js';
export type { AuditEntry } from './service/audit.service.js';
export type { DomainEvent, DeliveredEvent, EventHandler } from './service/events.service.js';
export type { SeriesInput, SeriesView } from './service/numbering.service.js';
export type { SettingView } from './service/settings.service.js';
export type { BackdatingCheck } from './service/backdating.service.js';
