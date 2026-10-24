/**
 * Holds the validated rows of a successful dry run until the commit (BR-10: files are processed in
 * memory and never written to storage). The uploaded file itself is dropped right after parsing;
 * the rows are discarded on commit, on rollback, or when newer dry runs push them out.
 */
export interface StagingStore {
  put(batchId: string, rows: readonly unknown[]): void;
  take(batchId: string): readonly unknown[] | undefined;
  discard(batchId: string): void;
  size(): number;
}

export const MAX_STAGED_BATCHES = 20;

export function createStagingStore(capacity = MAX_STAGED_BATCHES): StagingStore {
  const staged = new Map<string, readonly unknown[]>();
  return {
    put(batchId, rows) {
      staged.set(batchId, rows);
      for (const oldest of staged.keys()) {
        if (staged.size <= capacity) break;
        staged.delete(oldest);
      }
    },
    take: (batchId) => staged.get(batchId),
    discard(batchId) {
      staged.delete(batchId);
    },
    size: () => staged.size,
  };
}
