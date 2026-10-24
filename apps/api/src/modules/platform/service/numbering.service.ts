import { ConflictError, NotFoundError } from '@emporium/domain';
import {
  BusinessDate,
  allocateNumber,
  assertSeriesChangeAllowed,
  type Clock,
} from '@emporium/domain/kernel';
import {
  insertSeries,
  listSeries,
  lockSeries,
  storeCounter,
  updateSeriesDefinition,
  type SeriesDefinition,
  type SeriesRow,
} from '../repo/series.repo.js';
import type { Db } from '../types.js';
import type { AuditService } from './audit.service.js';

export interface SeriesView {
  code: string;
  prefix: string;
  padding: number;
  resetYearly: boolean;
  gapless: boolean;
  startValue: number;
  nextValue: number;
  currentYear: number | null;
  version: number;
}

export interface SeriesInput {
  code: string;
  prefix: string;
  padding: number;
  resetYearly: boolean;
  gapless: boolean;
  startValue: number;
  nextValue?: number | undefined;
  /** Required when the series already exists (optimistic concurrency). */
  version?: number | undefined;
}

export interface NumberingService {
  /** Allocates the next document number inside the caller's transaction (BR-1). */
  next(seriesCode: string, tx: Db): Promise<string>;
  list(db: Db): Promise<SeriesView[]>;
  save(
    input: SeriesInput,
    ctx: { actorUserId: string | null; requestId: string | null },
    tx: Db,
  ): Promise<SeriesView>;
}

const toView = (row: SeriesRow): SeriesView => ({
  code: row.code,
  prefix: row.prefix,
  padding: row.padding,
  resetYearly: row.reset_yearly,
  gapless: row.gapless,
  startValue: Number(row.start_value),
  nextValue: Number(row.next_value),
  currentYear: row.current_year,
  version: row.version,
});

export function createNumberingService(deps: {
  clock: Clock;
  audit: AuditService;
}): NumberingService {
  return {
    async next(seriesCode, tx) {
      const row = await lockSeries(tx, seriesCode);
      if (!row)
        throw new NotFoundError('series_not_found', `Number series ${seriesCode} not found`);
      const series = toView(row);
      const allocation = allocateNumber(
        { prefix: series.prefix, padding: series.padding, resetYearly: series.resetYearly },
        {
          nextValue: series.nextValue,
          currentYear: series.currentYear,
          startValue: series.startValue,
        },
        BusinessDate.today(deps.clock),
      );
      await storeCounter(tx, seriesCode, allocation.next);
      return allocation.number;
    },

    async list(db) {
      return (await listSeries(db)).map(toView);
    },

    async save(input, ctx, tx) {
      const definition: SeriesDefinition = {
        code: input.code,
        prefix: input.prefix,
        padding: input.padding,
        resetYearly: input.resetYearly,
        gapless: input.gapless,
        startValue: input.startValue,
        nextValue: input.nextValue ?? input.startValue,
      };
      const existingRow = await lockSeries(tx, input.code);
      if (!existingRow) {
        if (input.version !== undefined) {
          throw new NotFoundError('series_not_found', `Number series ${input.code} not found`);
        }
        const created = toView(await insertSeries(tx, definition, ctx.actorUserId));
        await deps.audit.record(
          {
            ...ctx,
            action: 'number_series.create',
            entityType: 'number_series',
            entityId: input.code,
            after: created,
          },
          tx,
        );
        return created;
      }

      if (input.version === undefined) {
        throw new ConflictError('series_exists', `Number series ${input.code} already exists`);
      }
      const before = toView(existingRow);
      const nextValue = input.nextValue ?? before.nextValue;
      assertSeriesChangeAllowed(
        {
          gapless: before.gapless,
          nextValue: before.nextValue,
          used: existingRow.last_allocated_at !== null,
        },
        { gapless: input.gapless, nextValue },
      );
      const updated = toView(
        (await updateSeriesDefinition(tx, {
          code: input.code,
          expectedVersion: input.version,
          actor: ctx.actorUserId,
          patch: {
            prefix: input.prefix,
            padding: input.padding,
            reset_yearly: input.resetYearly,
            gapless: input.gapless,
            start_value: input.startValue,
            next_value: nextValue,
          },
        })) as unknown as SeriesRow,
      );
      await deps.audit.record(
        {
          ...ctx,
          action: 'number_series.update',
          entityType: 'number_series',
          entityId: input.code,
          before,
          after: updated,
        },
        tx,
      );
      return updated;
    },
  };
}
