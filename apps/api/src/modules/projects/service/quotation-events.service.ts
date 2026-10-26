import type { Platform } from '../../platform/index.js';
import type { ProjectService, QuotationAcceptedPayload } from './projects.service.js';

/**
 * BR-1: accepting a quotation creates its project. The handler is idempotent, so a replayed or
 * duplicate event leaves one project.
 */
export function subscribeToQuotationAccepted(deps: {
  platform: Platform;
  projects: Pick<ProjectService, 'createFromQuotation'>;
}): void {
  deps.platform.events.subscribe(
    'quotation.accepted',
    async (event, tx) => {
      await deps.projects.createFromQuotation(event.payload as QuotationAcceptedPayload, tx);
    },
    'projects.quotation.accepted',
  );
}
