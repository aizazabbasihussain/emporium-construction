import { RuleViolationError } from '../errors.js';

export const projectStatuses = [
  'planning',
  'active',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

/** BR-4 and constitution 5.8: the allowed project transitions as an explicit table. */
export const projectTransitions: Record<ProjectStatus, readonly ProjectStatus[]> = {
  planning: ['active', 'cancelled'],
  active: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['active'],
  completed: ['closed'],
  closed: [],
  cancelled: [],
};

export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!projectTransitions[from].includes(to)) {
    throw new RuleViolationError('project_transition', `A project cannot go from ${from} to ${to}`);
  }
}

/** BR-4: the entries that stop a project from being closed, listed in the error. */
export interface OpenEntries {
  committed: readonly string[];
  unpostedApproved: readonly string[];
}

export function assertCanClose(open: OpenEntries): void {
  if (open.committed.length > 0 || open.unpostedApproved.length > 0) {
    throw new RuleViolationError(
      'project_has_open_costs',
      'A project with committed or unposted approved costs cannot be closed',
      { committed: open.committed, unpostedApproved: open.unpostedApproved },
    );
  }
}

export const costStatuses = ['committed', 'approved', 'posted', 'reversed'] as const;
export type CostStatus = (typeof costStatuses)[number];

/** BR-6: the only status changes a cost entry may go through. */
export const costTransitions: Record<CostStatus, readonly CostStatus[]> = {
  committed: ['approved', 'reversed'],
  approved: ['posted', 'reversed'],
  posted: ['reversed'],
  reversed: [],
};

export function assertCostTransition(from: CostStatus, to: CostStatus): void {
  if (!costTransitions[from].includes(to)) {
    throw new RuleViolationError('cost_transition', `A cost entry cannot go from ${from} to ${to}`);
  }
}
