import type { Clock } from '@emporium/domain/kernel';
import type { Billing } from '../../billing/index.js';
import type { Expenses } from '../../expenses/index.js';
import type { Notifications } from '../../notifications/index.js';
import type { Payables } from '../../payables/index.js';
import type { Payroll } from '../../payroll/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import type { Receivables } from '../../receivables/index.js';
import type { Variations } from '../../variations/index.js';

/** The owning modules' query interfaces this module composes (spec P2-08 section 2). */
export interface ProfitabilityDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject' | 'listProjectsForUser' | 'getCostSummary'>;
  variations: Pick<Variations, 'getCurrentContractValue'>;
  billing: Pick<Billing, 'getProjectBilling'>;
  receivables: Pick<Receivables, 'getProjectCollected' | 'getProjectAging'>;
  payables: Pick<Payables, 'getPaidForProject'>;
  payroll: Pick<Payroll, 'getPaidWagesForProject'>;
  expenses: Pick<Expenses, 'getReimbursedForProject'>;
  notifications: Pick<Notifications, 'notify' | 'notifyRole' | 'registerTemplate'>;
}
