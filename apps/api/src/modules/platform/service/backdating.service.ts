import { assertWithinBackdating, type BusinessDate, type Clock } from '@emporium/domain/kernel';
import type { Db } from '../types.js';
import type { AuditService } from './audit.service.js';
import type { SettingsService } from './settings.service.js';

export interface BackdatingCheck {
  date: BusinessDate;
  /** The caller holds `platform.backdate.override`. */
  canOverride: boolean;
  reason?: string | undefined;
  actorUserId: string | null;
  requestId?: string | null;
  /** The document the date belongs to, for the audit row. */
  entityType: string;
  entityId?: string | null;
}

export interface BackdatingService {
  /** Throws unless the date is allowed; an accepted override is audited with who, date and reason (BR-5). */
  check(input: BackdatingCheck, tx: Db): Promise<void>;
}

export function createBackdatingService(deps: {
  clock: Clock;
  settings: SettingsService;
  audit: AuditService;
}): BackdatingService {
  return {
    async check(input, tx) {
      const days = (await deps.settings.get(tx, 'backdating_days')).value as number;
      const result = assertWithinBackdating(input.date, deps.clock, days, {
        permitted: input.canOverride,
        reason: input.reason,
      });
      if (!result.overridden) return;
      await deps.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'backdate.override',
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          after: { date: input.date.toString(), reason: result.reason },
          requestId: input.requestId ?? null,
        },
        tx,
      );
    },
  };
}
