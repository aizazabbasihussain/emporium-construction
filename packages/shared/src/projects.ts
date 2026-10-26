/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the projects module. */
export const projectsPermissions = {
  read: 'projects.project.read',
  create: 'projects.project.create',
  update: 'projects.project.update',
  status: 'projects.project.status',
  budgetManage: 'projects.budget.manage',
  taskManage: 'projects.task.manage',
  costRead: 'projects.cost.read',
  /** System calls only: no role holds it (spec P1-09 section 6). */
  costPost: 'projects.cost.post',
} as const;

export type ProjectsPermission = (typeof projectsPermissions)[keyof typeof projectsPermissions];

const office = ['management', 'project_manager'] as const;

/** Roles that receive each permission (spec P1-09 section 6). */
export const projectsPermissionGrants: Record<ProjectsPermission, readonly string[]> = {
  'projects.project.read': [...office, 'accountant', 'supervisor'],
  'projects.project.create': office,
  'projects.project.update': office,
  'projects.project.status': office,
  'projects.budget.manage': office,
  'projects.task.manage': [...office, 'supervisor'],
  'projects.cost.read': [...office, 'accountant'],
  'projects.cost.post': [],
};

export const projectStatuses = [
  'planning',
  'active',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectSectors = ['government', 'private'] as const;
export type ProjectSector = (typeof projectSectors)[number];

/** Constitution 6: the lifecycle of a cost entry. */
export const costStatuses = ['committed', 'approved', 'posted', 'reversed'] as const;
export type CostStatus = (typeof costStatuses)[number];

/** Constitution 5.14: the kinds of cost object. */
export const costObjectTypes = ['project', 'work_order', 'overhead'] as const;
export type CostObjectType = (typeof costObjectTypes)[number];

export const budgetSources = ['estimate', 'manual', 'variation'] as const;
export type BudgetSource = (typeof budgetSources)[number];

export const taskStatuses = ['todo', 'doing', 'done'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

/** The number series of project codes (H-27) and the events other modules may follow. */
export const projectNumberSeries = 'project';

export const projectSettingKeys = {
  budgetWarningPercent: 'projects.budget_warning_percent',
  /** BR-11: set by P3-02 when work orders become cost objects. */
  workOrdersEnabled: 'projects.work_orders_enabled',
} as const;
