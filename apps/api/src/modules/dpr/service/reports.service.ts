import { ValidationError } from '@emporium/domain';
import {
  assertPhotoCapacity,
  assertPhotosForSubmit,
  assertReportEditable,
  assertReportTransition,
  assertWorkDone,
  checkTaskUpdate,
  isPastDeadline,
  isSiteHoliday,
  normalizeManpower,
  selectMissing,
  type ManpowerEntry,
  type ReportStatus,
  type TaskUpdate,
  type TaskUpdateInput,
} from '@emporium/domain/dpr';
import { scopeFilter } from '@emporium/domain/identity';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  dprReportEntityType,
  dprSettingKeys,
  platformPermissions,
  type DprStatus,
  type DprWeather,
  type FileOperation,
} from '@emporium/shared';
import type { Files } from '../../files/index.js';
import type { Notifications } from '../../notifications/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import {
  assertAuthor,
  assertCanRead,
  assertFound,
  assertProjectActive,
  assertProjectReachable,
  assertReportAbsent,
  assertUpdated,
  canAccessPhoto,
} from '../policy/dpr.policy.js';
import {
  claimMissingRun,
  findReport,
  findReportOfAuthorDay,
  insertReport,
  listFiledProjectIds,
  listMaterialNotes,
  listTaskUpdates,
  replaceMaterialNotes,
  replaceTaskUpdates,
  searchReports,
  updateReport,
  type ReportRow,
} from '../repo/dpr.repo.js';
import type {
  Actor,
  Db,
  MissingReportDto,
  PageResult,
  ReportDto,
  ReportHeaderDto,
} from '../types.js';
import { createRecorder, textOrNull } from './support.js';

export interface MaterialNoteInput {
  description: string;
  quantity?: string | null | undefined;
  unitCode?: string | null | undefined;
}

export interface ReportFields {
  weather?: DprWeather | undefined;
  workDone?: string | undefined;
  issues?: string | undefined;
  safetyNotes?: string | undefined;
  manpowerManual?: ManpowerEntry[] | undefined;
  taskUpdates?: TaskUpdateInput[] | undefined;
  materialNotes?: MaterialNoteInput[] | undefined;
}

export interface CreateReportInput extends ReportFields {
  projectId: string;
  reportDate: string;
}

export interface ReportQuery {
  projectId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: DprStatus | undefined;
  mine?: boolean | undefined;
  limit: number;
  offset: number;
}

export interface DprDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<
    Projects,
    'getProject' | 'getTask' | 'updateTaskProgress' | 'listSupervisedProjects'
  >;
  files: Pick<Files, 'list' | 'registerFileAccess'>;
  notifications: Pick<Notifications, 'notify' | 'notifyRole' | 'registerTemplate'>;
}

export interface ReportService {
  create(input: CreateReportInput, actor: Actor, tx: Db): Promise<ReportDto>;
  update(
    id: string,
    patch: ReportFields,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<ReportDto>;
  submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<ReportDto>;
  review(
    id: string,
    note: string | undefined,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<ReportDto>;
  reopen(
    id: string,
    note: string | undefined,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<ReportDto>;
  get(db: Db, id: string, actor: Actor): Promise<ReportDto>;
  list(db: Db, query: ReportQuery, actor: Actor): Promise<PageResult<ReportHeaderDto>>;
  /** Module interface `getMissingDprs` (spec section 2, BR-6). */
  getMissing(db: Db, date: string): Promise<MissingReportDto[]>;
  /** BR-6: from 18:00 Asia/Karachi, once a day, tells the project managers about missing reports. */
  notifyMissing(tx: Db, now: Date): Promise<number>;
  /** BR-5 and BR-7: who may read, add and remove the photos of a report. */
  photoAccess(request: {
    actor: Actor;
    entityId: string;
    operation: FileOperation;
    db: Db;
  }): Promise<boolean>;
}

const orElse = <T>(value: T | undefined, fallback: T): T => value ?? fallback;

const headerOf = (row: ReportRow): ReportHeaderDto => ({
  id: row.id,
  projectId: row.project_id,
  reportDate: row.report_date,
  authorId: row.author_id,
  weather: row.weather as DprWeather,
  status: row.status as DprStatus,
  workDone: row.work_done,
  issues: row.issues,
  safetyNotes: row.safety_notes,
  manpowerManual: row.manpower_manual,
  submittedAt: row.submitted_at?.toISOString() ?? null,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at?.toISOString() ?? null,
  reviewNote: row.review_note,
  version: row.version,
});

export function createReportService(deps: DprDeps): ReportService {
  const { platform, clock, newId, projects, files, notifications } = deps;
  const record = createRecorder(platform);

  const changed = (row: ReportRow, change: string) => ({
    type: 'dpr.report.changed',
    payload: { reportId: row.id, projectId: row.project_id, change },
  });

  const view = async (db: Db, row: ReportRow, actor: Actor): Promise<ReportDto> => ({
    ...headerOf(row),
    taskUpdates: (await listTaskUpdates(db, row.id)).map((update) => ({
      taskId: update.task_id,
      percentComplete: update.percent_complete,
      note: update.note,
    })),
    materialNotes: (await listMaterialNotes(db, row.id)).map((note) => ({
      description: note.description,
      quantity: note.quantity,
      unitCode: note.unit_code,
    })),
    photoCount: (await files.list(db, actor, dprReportEntityType, row.id)).length,
  });

  /** BR-4: each update names a task of the project, once, and respects the no-decrease rule. */
  const checkTasks = async (
    db: Db,
    projectId: string,
    updates: readonly TaskUpdateInput[],
  ): Promise<TaskUpdate[]> => {
    if (new Set(updates.map((update) => update.taskId)).size !== updates.length) {
      throw new ValidationError('task_duplicate', 'A task can be updated once in a report');
    }
    const checked: TaskUpdate[] = [];
    for (const update of updates) {
      const task = await projects.getTask(db, projectId, update.taskId);
      checked.push(checkTaskUpdate(update, task.percentComplete));
    }
    return checked;
  };

  const materialsOf = (notes: readonly MaterialNoteInput[]) =>
    notes.map((note) => {
      const description = textOrNull(note.description);
      if (description === null) {
        throw new ValidationError(
          'material_description_required',
          'A material needs a description',
        );
      }
      return {
        id: newId(),
        description,
        quantity: note.quantity ?? null,
        unitCode: textOrNull(note.unitCode),
      };
    });

  const saveLists = async (tx: Db, row: ReportRow, fields: ReportFields): Promise<void> => {
    if (fields.taskUpdates !== undefined) {
      await replaceTaskUpdates(
        tx,
        row.id,
        await checkTasks(tx, row.project_id, fields.taskUpdates),
      );
    }
    if (fields.materialNotes !== undefined) {
      await replaceMaterialNotes(tx, row.id, materialsOf(fields.materialNotes));
    }
  };

  /** Locks a report the caller may see. */
  const locked = async (tx: Db, id: string, actor: Actor): Promise<ReportRow> => {
    const row = assertFound(await findReport(tx, id, true), 'report');
    assertCanRead(actor, row.project_id);
    return row;
  };

  const move = async (
    tx: Db,
    row: ReportRow,
    to: ReportStatus,
    expectedVersion: number,
    values: Record<string, unknown>,
    actor: Actor,
  ): Promise<ReportRow> => {
    assertReportTransition(row.status as ReportStatus, to);
    return assertUpdated(
      await updateReport(
        tx,
        row.id,
        expectedVersion,
        { status: to, ...values },
        actor.userId,
        clock.now(),
      ),
    );
  };

  const decide = async (
    tx: Db,
    id: string,
    to: 'reviewed' | 'reopened',
    note: string | undefined,
    expectedVersion: number,
    actor: Actor,
  ): Promise<ReportDto> => {
    const row = await locked(tx, id, actor);
    const at = clock.now();
    const next = await move(
      tx,
      row,
      to,
      expectedVersion,
      { reviewed_by: actor.userId, reviewed_at: at.toISOString(), review_note: textOrNull(note) },
      actor,
    );
    await record(tx, actor, {
      action: `dpr.report.${to}`,
      entityType: 'dpr_report',
      entityId: id,
      before: { status: row.status },
      after: { status: next.status, reviewNote: next.review_note },
      event:
        to === 'reviewed'
          ? {
              type: 'dpr.reviewed',
              payload: { reportId: id, projectId: row.project_id, reviewedBy: actor.userId },
            }
          : changed(next, to),
    });
    return view(tx, next, actor);
  };

  return {
    async create(input, actor, tx) {
      assertProjectReachable(actor, input.projectId);
      assertProjectActive((await projects.getProject(tx, input.projectId)).status);
      // BR-1: not in the future, and within the backdating allowance.
      const date = BusinessDate.parse(input.reportDate).toString();
      await platform.backdating.check(
        {
          date: BusinessDate.parse(date),
          canOverride: actor.permissions.has(platformPermissions.backdateOverride),
          actorUserId: actor.userId,
          requestId: actor.requestId,
          entityType: 'dpr_report',
        },
        tx,
      );
      // BR-2: one report per author per project per date.
      assertReportAbsent(
        (await findReportOfAuthorDay(tx, input.projectId, date, actor.userId)) !== undefined,
      );
      const manpower = normalizeManpower(orElse(input.manpowerManual, []));
      const row = await insertReport(
        tx,
        {
          id: newId(),
          project_id: input.projectId,
          report_date: date,
          author_id: actor.userId,
          weather: orElse(input.weather, 'clear'),
          work_done: orElse(input.workDone, '').trim(),
          issues: orElse(input.issues, '').trim(),
          safety_notes: orElse(input.safetyNotes, '').trim(),
          manpower_manual: JSON.stringify(manpower),
          status: 'draft',
        },
        actor.userId,
        clock.now(),
      );
      await saveLists(tx, row, input);
      await record(tx, actor, {
        action: 'dpr.report.create',
        entityType: 'dpr_report',
        entityId: row.id,
        after: { projectId: row.project_id, reportDate: row.report_date },
        event: changed(row, 'created'),
      });
      return view(tx, row, actor);
    },

    async update(id, patch, expectedVersion, actor, tx) {
      const row = await locked(tx, id, actor);
      assertAuthor(actor, row.author_id);
      assertReportEditable(row.status as ReportStatus);
      const values: Record<string, unknown> = {};
      if (patch.weather !== undefined) values.weather = patch.weather;
      if (patch.workDone !== undefined) values.work_done = patch.workDone.trim();
      if (patch.issues !== undefined) values.issues = patch.issues.trim();
      if (patch.safetyNotes !== undefined) values.safety_notes = patch.safetyNotes.trim();
      if (patch.manpowerManual !== undefined) {
        values.manpower_manual = JSON.stringify(normalizeManpower(patch.manpowerManual));
      }
      const next = assertUpdated(
        await updateReport(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await saveLists(tx, next, patch);
      await record(tx, actor, {
        action: 'dpr.report.update',
        entityType: 'dpr_report',
        entityId: id,
        before: headerOf(row),
        after: headerOf(next),
        event: changed(next, 'updated'),
      });
      return view(tx, next, actor);
    },

    async submit(id, expectedVersion, actor, tx) {
      const row = await locked(tx, id, actor);
      assertAuthor(actor, row.author_id);
      assertReportTransition(row.status as ReportStatus, 'submitted');
      // BR-3: work done text and, unless the setting is off, at least one photo.
      assertWorkDone(row.work_done);
      const required = (await platform.settings.get(tx, dprSettingKeys.photoRequired)).value;
      const photos = await files.list(tx, actor, dprReportEntityType, id);
      assertPhotosForSubmit(photos.length, required === true);
      // BR-4: the task percents move on the project through its interface.
      for (const update of await listTaskUpdates(tx, id)) {
        const task = await projects.getTask(tx, row.project_id, update.task_id);
        const checked = checkTaskUpdate(
          { taskId: update.task_id, percentComplete: update.percent_complete, note: update.note },
          task.percentComplete,
        );
        await projects.updateTaskProgress(
          row.project_id,
          checked.taskId,
          checked.percentComplete,
          { userId: actor.userId, requestId: actor.requestId },
          tx,
        );
      }
      const next = await move(
        tx,
        row,
        'submitted',
        expectedVersion,
        { submitted_at: clock.now().toISOString() },
        actor,
      );
      await record(tx, actor, {
        action: 'dpr.report.submit',
        entityType: 'dpr_report',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status },
        event: {
          type: 'dpr.submitted',
          payload: {
            reportId: id,
            projectId: row.project_id,
            reportDate: row.report_date,
            authorId: row.author_id,
          },
        },
      });
      return view(tx, next, actor);
    },

    review: (id, note, expectedVersion, actor, tx) =>
      decide(tx, id, 'reviewed', note, expectedVersion, actor),

    reopen: (id, note, expectedVersion, actor, tx) =>
      decide(tx, id, 'reopened', note, expectedVersion, actor),

    async get(db, id, actor) {
      const row = assertFound(await findReport(db, id), 'report');
      assertCanRead(actor, row.project_id);
      return view(db, row, actor);
    },

    async list(db, query, actor) {
      const scope = scopeFilter(actor, 'project');
      const { rows, total } = await searchReports(db, {
        projectIds: scope.all ? undefined : scope.ids,
        projectId: query.projectId,
        from: query.from,
        to: query.to,
        status: query.status,
        authorId: query.mine === true ? actor.userId : undefined,
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows.map(headerOf), total, limit: query.limit, offset: query.offset };
    },

    async getMissing(db, date) {
      const day = BusinessDate.parse(date).toString();
      const filed = new Set(await listFiledProjectIds(db, day));
      const supervised = await projects.listSupervisedProjects(db, day);
      return selectMissing(supervised, filed).map((project) => ({ ...project, date: day }));
    },

    async notifyMissing(tx, now) {
      if (!isPastDeadline(now)) return 0;
      const day = BusinessDate.fromInstant(now).toString();
      const holidays = (await platform.settings.get(tx, dprSettingKeys.siteHolidays)).value;
      const missing = isSiteHoliday(day, String(holidays)) ? [] : await this.getMissing(tx, day);
      if (!(await claimMissingRun(tx, day, missing.length))) return 0;
      const byManager = new Map<string | null, MissingReportDto[]>();
      for (const project of missing) {
        byManager.set(project.projectManagerId, [
          ...(byManager.get(project.projectManagerId) ?? []),
          project,
        ]);
      }
      for (const [manager, list] of byManager) {
        const data = { date: day, projects: list.map((p) => `${p.code} ${p.name}`).join(', ') };
        if (manager === null)
          await notifications.notifyRole('project_manager', 'dpr.missing', data, tx);
        else await notifications.notify([manager], 'dpr.missing', data, tx);
      }
      return missing.length;
    },

    async photoAccess({ actor, entityId, operation, db }) {
      const row = await findReport(db, entityId);
      const allowed = canAccessPhoto({
        caller: actor,
        operation,
        report:
          row === undefined
            ? undefined
            : {
                projectId: row.project_id,
                authorId: row.author_id,
                status: row.status as ReportStatus,
              },
      });
      // BR-7: at most 20 photos on a report.
      if (allowed && operation === 'upload') {
        assertPhotoCapacity((await files.list(db, actor, dprReportEntityType, entityId)).length);
      }
      return allowed;
    },
  };
}
