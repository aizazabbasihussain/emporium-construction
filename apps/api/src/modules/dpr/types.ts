import type { ScopeGrant } from '@emporium/domain/identity';
import type { DprStatus, DprWeather } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting; supervisors are limited to the projects in their scopes. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ManpowerDto {
  trade: string;
  count: number;
}

export interface TaskUpdateDto {
  taskId: string;
  percentComplete: number;
  note: string | null;
}

export interface MaterialNoteDto {
  description: string;
  quantity: string | null;
  unitCode: string | null;
}

export interface ReportHeaderDto {
  id: string;
  projectId: string;
  reportDate: string;
  authorId: string;
  weather: DprWeather;
  status: DprStatus;
  workDone: string;
  issues: string;
  safetyNotes: string;
  manpowerManual: ManpowerDto[];
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  version: number;
}

export interface ReportDto extends ReportHeaderDto {
  taskUpdates: TaskUpdateDto[];
  materialNotes: MaterialNoteDto[];
  photoCount: number;
}

/** A project that should have reported on a day and has not (BR-6). */
export interface MissingReportDto {
  projectId: string;
  code: string;
  name: string;
  projectManagerId: string | null;
  supervisorIds: string[];
  date: string;
}
