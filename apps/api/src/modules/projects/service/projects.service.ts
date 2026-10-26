import { ValidationError } from '@emporium/domain';
import {
  assertAssignmentDates,
  assertCanClose,
  assertProjectTransition,
  assertSectorAllowed,
  assertTaskProgress,
  budgetFromCostLines,
  isAssignmentOpen,
  normalizeBudgetAmount,
  normalizeContractValue,
  projectProgress,
  type ProjectStatus,
  type TaskStatus,
} from '@emporium/domain/costing';
import { scopeFilter, type ScopeGrant } from '@emporium/domain/identity';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { projectNumberSeries, type BudgetSource, type ProjectSector } from '@emporium/shared';
import type { Estimation } from '../../estimation/index.js';
import type { Identity } from '../../identity/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Quotations } from '../../quotations/index.js';
import {
  assertBudgetEditable,
  assertCostCodeActive,
  assertFound,
  assertKnown,
  assertProjectReachable,
  assertUpdated,
} from '../policy/projects.policy.js';
import { openEntriesOf } from '../repo/ledger.repo.js';
import {
  findProject,
  findProjectByQuotation,
  findTask,
  insertAssignment,
  insertBudgetLine,
  insertProject,
  insertTask,
  listAssignments,
  listBudgetLines,
  listTasks,
  removeBudgetLine,
  searchProjects,
  setAssignmentEnd,
  setBudgetAmount,
  taskPercentsFor,
  updateProject,
  updateTask,
  type BudgetLineRow,
  type ProjectRow,
  type TaskRow,
} from '../repo/projects.repo.js';
import type {
  Actor,
  BudgetDto,
  BudgetLineDto,
  Db,
  PageResult,
  ProjectDetailDto,
  ProjectDto,
  TaskDto,
} from '../types.js';
import { createRecorder, pageOf, requiredText, textOrNull, type Recorded } from './support.js';

export interface ProjectQuery {
  q?: string | undefined;
  status?: string | undefined;
  partyId?: string | undefined;
  limit: number;
  offset: number;
}

export interface ManualProjectInput {
  name: string;
  partyId: string;
  sector: ProjectSector;
  originalContractValue: string;
  locationId?: string | null | undefined;
  siteAddress?: string | null | undefined;
  startDate?: string | null | undefined;
  plannedEndDate?: string | null | undefined;
  projectManagerId?: string | null | undefined;
}

export type ProjectPatch = Partial<
  Pick<
    ManualProjectInput,
    'name' | 'locationId' | 'siteAddress' | 'startDate' | 'plannedEndDate' | 'projectManagerId'
  >
>;

export interface BudgetLineInput {
  costCodeId: string;
  description?: string | undefined;
  budgetAmount: string;
}

export interface TaskInput {
  name: string;
  assignedToUser?: string | null | undefined;
  startDate?: string | null | undefined;
  dueDate?: string | null | undefined;
  status?: TaskStatus | undefined;
  percentComplete?: number | undefined;
}

export type TaskPatch = Partial<TaskInput>;

export interface SupervisorInput {
  userId: string;
  fromDate?: string | undefined;
  toDate?: string | null | undefined;
}

/** The payload of `quotation.accepted` that this module reads (P1-08 section 2). */
export interface QuotationAcceptedPayload {
  quotationId: string;
  estimateId: string;
  partyId: string;
  sector: ProjectSector;
  locationId: string | null;
  contractValue: string;
}

export interface ProjectService {
  list(db: Db, query: ProjectQuery, actor: Actor): Promise<PageResult<ProjectDto>>;
  get(db: Db, id: string, actor: Actor): Promise<ProjectDetailDto>;
  /** Module interface `getProject` (spec section 2): no caller scope. */
  summary(db: Db, id: string): Promise<ProjectDto>;
  /** Module interface `listProjectsForUser`. */
  listForUser(db: Db, actor: Actor): Promise<ProjectDto[]>;
  create(input: ManualProjectInput, actor: Actor, tx: Db): Promise<ProjectDetailDto>;
  /** BR-1: one project per quotation; a repeat returns the project that exists. */
  createFromQuotation(payload: QuotationAcceptedPayload, tx: Db): Promise<ProjectDto>;
  update(
    id: string,
    patch: ProjectPatch,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<ProjectDetailDto>;
  transition(
    id: string,
    to: ProjectStatus,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<ProjectDetailDto>;
  getBudget(db: Db, id: string, actor: Actor): Promise<BudgetDto>;
  replaceBudget(
    id: string,
    lines: BudgetLineInput[],
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<BudgetDto>;
  /** Module interface `addBudgetLine` (used by variations): appends a line with source `variation`. */
  addBudgetLine(
    projectId: string,
    line: BudgetLineInput,
    tx: Db,
    actor?: Recorded,
  ): Promise<BudgetLineDto>;
  /** Module interface `getEstimateBudgetSource`: the estimate a project's budget came from. */
  getEstimateBudgetSource(db: Db, id: string): Promise<string | null>;
  listTasks(db: Db, id: string, actor: Actor): Promise<TaskDto[]>;
  createTask(id: string, input: TaskInput, actor: Actor, tx: Db): Promise<TaskDto>;
  updateTask(
    id: string,
    taskId: string,
    patch: TaskPatch,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<TaskDto>;
  setSupervisors(
    id: string,
    supervisors: SupervisorInput[],
    actor: Actor,
    tx: Db,
  ): Promise<ProjectDetailDto>;
}

const SYSTEM: Recorded = { userId: null, requestId: null };

const budgetLineOf = (row: BudgetLineRow): BudgetLineDto => ({
  id: row.id,
  costCodeId: row.cost_code_id,
  description: row.description,
  budgetAmount: row.budget_amount,
  source: row.source as BudgetSource,
});

const taskOf = (row: TaskRow): TaskDto => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  assignedToUser: row.assigned_to_user,
  startDate: row.start_date,
  dueDate: row.due_date,
  status: row.status as TaskStatus,
  percentComplete: row.percent_complete,
  version: row.version,
});

const projectOf = (row: ProjectRow, percents: readonly number[]): ProjectDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  partyId: row.party_id,
  sector: row.sector as ProjectSector,
  locationId: row.location_id,
  siteAddress: row.site_address,
  status: row.status as ProjectStatus,
  startDate: row.start_date,
  plannedEndDate: row.planned_end_date,
  actualEndDate: row.actual_end_date,
  originalContractValue: row.original_contract_value,
  quotationId: row.quotation_id,
  estimateId: row.estimate_id,
  projectManagerId: row.project_manager_id,
  progressPercent: projectProgress(percents),
  version: row.version,
});

/** A date typed by the user must be a real calendar day. */
const dateOrNull = (value: string | null | undefined): string | null => {
  const text = textOrNull(value);
  return text === null ? null : BusinessDate.parse(text).toString();
};

export function createProjectService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  /** Constitution 9.3: set only in the Pakistan-hosted environment. */
  allowGovernmentData: boolean;
  masterData: Pick<MasterData, 'getParty' | 'listLocations' | 'getCostCode'>;
  identity: Pick<Identity, 'users'>;
  quotations: Pick<Quotations, 'getQuotation'>;
  estimation: Pick<Estimation, 'getEstimateCostLines'>;
}): ProjectService {
  const { platform, clock, newId, masterData, identity } = deps;
  const record = createRecorder(platform);
  const today = () => BusinessDate.today(clock).toString();

  const progressOf = async (db: Db, rows: readonly ProjectRow[]): Promise<ProjectDto[]> => {
    const percents = await taskPercentsFor(
      db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => projectOf(row, percents.get(row.id) ?? []));
  };

  const detailOf = async (db: Db, row: ProjectRow): Promise<ProjectDetailDto> => {
    const [project] = await progressOf(db, [row]);
    const supervisors = (await listAssignments(db, row.id)).map((a) => ({
      userId: a.user_id,
      fromDate: a.from_date,
      toDate: a.to_date,
    }));
    return { ...(project as ProjectDto), supervisors };
  };

  const locked = async (tx: Db, id: string, actor: Actor): Promise<ProjectRow> => {
    assertProjectReachable(actor, id);
    return assertFound(await findProject(tx, id, true), 'project');
  };

  const checkReferences = async (
    db: Db,
    refs: { partyId?: string | undefined; locationId?: string | null | undefined },
  ): Promise<void> => {
    if (refs.partyId !== undefined) {
      assertKnown(
        (await masterData.getParty(db, refs.partyId)) !== undefined,
        'party_not_found',
        'The client does not exist',
      );
    }
    if (refs.locationId !== undefined && refs.locationId !== null) {
      const locations = await masterData.listLocations(db);
      assertKnown(
        locations.some((location) => location.id === refs.locationId),
        'location_not_found',
        'The location does not exist',
      );
    }
  };

  const activeCostCode = async (db: Db, id: string): Promise<void> => {
    assertCostCodeActive((await masterData.getCostCode(db, id)).active);
  };

  const announce = (
    tx: Db,
    actor: Recorded,
    row: ProjectRow,
    change: string,
    before: unknown,
    after: unknown,
  ) =>
    record(tx, actor, {
      action: `projects.project.${change}`,
      entityType: 'prj_project',
      entityId: row.id,
      before,
      after,
      event: { type: 'projects.project.changed', payload: { projectId: row.id, change } },
    });

  const insertBudget = async (
    tx: Db,
    projectId: string,
    line: { costCodeId: string; description: string; amount: string; source: BudgetSource },
    by: string | null,
  ): Promise<BudgetLineDto> =>
    budgetLineOf(
      await insertBudgetLine(
        tx,
        {
          id: newId(),
          project_id: projectId,
          cost_code_id: line.costCodeId,
          description: line.description,
          budget_amount: line.amount,
          source: line.source,
        },
        by,
        clock.now(),
      ),
    );

  const budgetOf = async (db: Db, row: ProjectRow): Promise<BudgetDto> => ({
    projectVersion: row.version,
    lines: (await listBudgetLines(db, row.id)).map(budgetLineOf),
  });

  const insertNewProject = async (
    tx: Db,
    values: Record<string, unknown>,
    by: string | null,
  ): Promise<ProjectRow> => {
    const id = newId();
    const code = await platform.numbering.next(projectNumberSeries, tx);
    return insertProject(tx, { id, code, ...values }, by, clock.now());
  };

  const announceCreated = (tx: Db, actor: Recorded, row: ProjectRow) =>
    record(tx, actor, {
      action: 'projects.project.create',
      entityType: 'prj_project',
      entityId: row.id,
      after: { code: row.code, status: row.status, quotationId: row.quotation_id },
      event: {
        type: 'project.created',
        payload: {
          projectId: row.id,
          code: row.code,
          partyId: row.party_id,
          sector: row.sector,
          quotationId: row.quotation_id,
        },
      },
    });

  return {
    async list(db, query, actor) {
      const filter = scopeFilter(actor, 'project');
      const { rows, total } = await searchProjects(db, {
        ...query,
        onlyIds: filter.all ? undefined : filter.ids,
      });
      return pageOf(await progressOf(db, rows), total, query);
    },

    async get(db, id, actor) {
      assertProjectReachable(actor, id);
      return detailOf(db, assertFound(await findProject(db, id), 'project'));
    },

    async summary(db, id) {
      const [project] = await progressOf(db, [assertFound(await findProject(db, id), 'project')]);
      return project as ProjectDto;
    },

    async listForUser(db, actor) {
      const filter = scopeFilter(actor, 'project');
      const { rows } = await searchProjects(db, {
        onlyIds: filter.all ? undefined : filter.ids,
        limit: 1000,
        offset: 0,
      });
      return progressOf(db, rows);
    },

    async create(input, actor, tx) {
      const name = requiredText(input.name, 'name');
      assertSectorAllowed(input.sector, deps.allowGovernmentData);
      const value = normalizeContractValue(input.originalContractValue);
      await checkReferences(tx, { partyId: input.partyId, locationId: input.locationId });
      const row = await insertNewProject(
        tx,
        {
          name,
          party_id: input.partyId,
          sector: input.sector,
          location_id: input.locationId ?? null,
          site_address: textOrNull(input.siteAddress),
          start_date: dateOrNull(input.startDate),
          planned_end_date: dateOrNull(input.plannedEndDate),
          original_contract_value: value,
          project_manager_id: input.projectManagerId ?? null,
        },
        actor.userId,
      );
      await announceCreated(tx, actor, row);
      return detailOf(tx, row);
    },

    async createFromQuotation(payload, tx) {
      const existing = await findProjectByQuotation(tx, payload.quotationId);
      if (existing !== undefined) return (await progressOf(tx, [existing]))[0] as ProjectDto;
      assertSectorAllowed(payload.sector, deps.allowGovernmentData);
      const quotation = await deps.quotations.getQuotation(tx, payload.quotationId);
      const row = await insertNewProject(
        tx,
        {
          name: quotation.title,
          party_id: payload.partyId,
          sector: payload.sector,
          location_id: payload.locationId,
          original_contract_value: payload.contractValue,
          quotation_id: payload.quotationId,
          estimate_id: payload.estimateId,
        },
        null,
      );
      const lines = await deps.estimation.getEstimateCostLines(tx, payload.estimateId);
      for (const line of budgetFromCostLines(lines)) {
        await insertBudget(
          tx,
          row.id,
          { costCodeId: line.costCodeId, description: '', amount: line.amount, source: 'estimate' },
          null,
        );
      }
      await announceCreated(tx, SYSTEM, row);
      return (await progressOf(tx, [row]))[0] as ProjectDto;
    },

    async update(id, patch, expectedVersion, actor, tx) {
      const existing = await locked(tx, id, actor);
      await checkReferences(tx, { locationId: patch.locationId });
      const values: Record<string, unknown> = {};
      if (patch.name !== undefined) values.name = requiredText(patch.name, 'name');
      if (patch.locationId !== undefined) values.location_id = patch.locationId;
      if (patch.siteAddress !== undefined) values.site_address = textOrNull(patch.siteAddress);
      if (patch.startDate !== undefined) values.start_date = dateOrNull(patch.startDate);
      if (patch.plannedEndDate !== undefined) {
        values.planned_end_date = dateOrNull(patch.plannedEndDate);
      }
      if (patch.projectManagerId !== undefined) values.project_manager_id = patch.projectManagerId;
      const row = assertUpdated(
        await updateProject(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await announce(tx, actor, row, 'update', existing, row);
      return detailOf(tx, row);
    },

    async transition(id, to, expectedVersion, actor, tx) {
      const existing = await locked(tx, id, actor);
      assertProjectTransition(existing.status as ProjectStatus, to);
      if (to === 'closed') assertCanClose(await openEntriesOf(tx, id));
      const values: Record<string, unknown> = { status: to };
      if (to === 'completed') values.actual_end_date = today();
      const row = assertUpdated(
        await updateProject(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'projects.project.status',
        entityType: 'prj_project',
        entityId: id,
        before: { status: existing.status },
        after: { status: to },
        event: {
          type: 'project.status.changed',
          payload: { projectId: id, from: existing.status, to },
        },
      });
      return detailOf(tx, row);
    },

    async getBudget(db, id, actor) {
      assertProjectReachable(actor, id);
      return budgetOf(db, assertFound(await findProject(db, id), 'project'));
    },

    async replaceBudget(id, lines, expectedVersion, actor, tx) {
      const existing = await locked(tx, id, actor);
      assertBudgetEditable(existing.status);
      const wanted = new Map<string, { costCodeId: string; description: string; amount: string }>();
      for (const line of lines) {
        const description = textOrNull(line.description) ?? '';
        const key = `${line.costCodeId}|${description}`;
        if (wanted.has(key)) {
          throw new ValidationError('budget_line_duplicate', 'A cost code and description repeat');
        }
        await activeCostCode(tx, line.costCodeId);
        wanted.set(key, {
          costCodeId: line.costCodeId,
          description,
          amount: normalizeBudgetAmount(line.budgetAmount),
        });
      }
      const row = assertUpdated(
        await updateProject(tx, id, expectedVersion, {}, actor.userId, clock.now()),
      );
      const before = await listBudgetLines(tx, id);
      // Lines added by variations belong to P1-10; the editor neither shows nor changes them.
      for (const line of before.filter((l) => l.source !== 'variation')) {
        const key = `${line.cost_code_id}|${line.description}`;
        const next = wanted.get(key);
        if (next === undefined) {
          await removeBudgetLine(tx, line.id, actor.userId, clock.now());
        } else {
          if (next.amount !== line.budget_amount) {
            await setBudgetAmount(tx, line.id, next.amount, actor.userId, clock.now());
          }
          wanted.delete(key);
        }
      }
      for (const line of wanted.values()) {
        await insertBudget(tx, id, { ...line, source: 'manual' }, actor.userId);
      }
      const after = await budgetOf(tx, row);
      await announce(tx, actor, row, 'budget', before, after.lines);
      return after;
    },

    async addBudgetLine(projectId, line, tx, actor = SYSTEM) {
      const project = assertFound(await findProject(tx, projectId, true), 'project');
      assertBudgetEditable(project.status);
      await activeCostCode(tx, line.costCodeId);
      // The budget editor guards on the project version, so a new line moves it on.
      assertUpdated(
        await updateProject(tx, projectId, project.version, {}, actor.userId, clock.now()),
      );
      const created = await insertBudget(
        tx,
        projectId,
        {
          costCodeId: line.costCodeId,
          description: textOrNull(line.description) ?? '',
          amount: normalizeBudgetAmount(line.budgetAmount),
          source: 'variation',
        },
        actor.userId,
      );
      await announce(tx, actor, project, 'budget', null, created);
      return created;
    },

    async getEstimateBudgetSource(db, id) {
      return assertFound(await findProject(db, id), 'project').estimate_id;
    },

    async listTasks(db, id, actor) {
      assertProjectReachable(actor, id);
      assertFound(await findProject(db, id), 'project');
      return (await listTasks(db, id)).map(taskOf);
    },

    async createTask(id, input, actor, tx) {
      const project = await locked(tx, id, actor);
      const status = input.status ?? 'todo';
      const percent = input.percentComplete ?? (status === 'done' ? 100 : 0);
      assertTaskProgress(status, percent);
      const row = await insertTask(
        tx,
        {
          id: newId(),
          project_id: id,
          name: requiredText(input.name, 'name'),
          assigned_to_user: input.assignedToUser ?? null,
          start_date: dateOrNull(input.startDate),
          due_date: dateOrNull(input.dueDate),
          status,
          percent_complete: percent,
        },
        actor.userId,
        clock.now(),
      );
      await announce(tx, actor, project, 'task', null, taskOf(row));
      return taskOf(row);
    },

    async updateTask(id, taskId, patch, expectedVersion, actor, tx) {
      const project = await locked(tx, id, actor);
      const existing = assertFound(await findTask(tx, taskId, true), 'task');
      assertKnown(existing.project_id === id, 'task_not_found', 'Not found');
      const status = patch.status ?? (existing.status as TaskStatus);
      const percent =
        patch.percentComplete ?? (status === 'done' ? 100 : existing.percent_complete);
      assertTaskProgress(status, percent);
      const values: Record<string, unknown> = { status, percent_complete: percent };
      if (patch.name !== undefined) values.name = requiredText(patch.name, 'name');
      if (patch.assignedToUser !== undefined) values.assigned_to_user = patch.assignedToUser;
      if (patch.startDate !== undefined) values.start_date = dateOrNull(patch.startDate);
      if (patch.dueDate !== undefined) values.due_date = dateOrNull(patch.dueDate);
      const row = assertUpdated(
        await updateTask(tx, taskId, expectedVersion, values, actor.userId, clock.now()),
      );
      await announce(tx, actor, project, 'task', taskOf(existing), taskOf(row));
      return taskOf(row);
    },

    async setSupervisors(id, supervisors, actor, tx) {
      const project = await locked(tx, id, actor);
      const now = today();
      const before = await listAssignments(tx, id);
      const wanted = new Map(supervisors.map((s) => [s.userId, s]));
      const touched = new Set<string>();
      for (const [userId, input] of wanted) {
        const open = before.find((a) => a.user_id === userId && isAssignmentOpen(a.to_date, now));
        const from = dateOrNull(input.fromDate) ?? open?.from_date ?? now;
        const to = dateOrNull(input.toDate);
        assertAssignmentDates(from, to);
        if (open === undefined) {
          await insertAssignment(tx, id, userId, from, to);
          touched.add(userId);
        } else if (open.to_date !== to) {
          await setAssignmentEnd(tx, id, userId, open.from_date, to);
          touched.add(userId);
        }
      }
      // BR-9: a supervisor left out of the list is ended today; the history stays.
      for (const a of before) {
        if (!wanted.has(a.user_id) && isAssignmentOpen(a.to_date, now)) {
          await setAssignmentEnd(tx, id, a.user_id, a.from_date, now);
          touched.add(a.user_id);
        }
      }
      const after = await listAssignments(tx, id);
      const users = await identity.users.list(tx);
      for (const userId of touched) {
        const user = assertFound(
          users.find((candidate) => candidate.id === userId),
          'user',
        );
        const holds = after.some((a) => a.user_id === userId && isAssignmentOpen(a.to_date, now));
        const others = user.scopes.filter((s) => !(s.type === 'project' && s.id === id));
        const scopes: ScopeGrant[] = holds ? [...others, { type: 'project', id }] : others;
        await identity.users.setScopes(
          userId,
          scopes,
          user.version,
          { actorUserId: actor.userId, requestId: actor.requestId },
          tx,
        );
      }
      await announce(tx, actor, project, 'supervisors', before, after);
      return detailOf(tx, project);
    },
  };
}
