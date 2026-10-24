import { createHash } from 'node:crypto';
import { RuleViolationError } from '@emporium/domain';
import { findIdempotent, storeIdempotent } from '../repo/idempotency.repo.js';
import type { Db } from '../types.js';

export interface CommandResult {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyService {
  /**
   * Runs `run` once per (key, user). A repeat with the same request hash returns the stored response;
   * the same key with a different hash is a 422 (BR-7). The response is stored in the command's transaction.
   */
  execute(
    db: Db,
    params: { key: string; userId: string; requestHash: string },
    run: (tx: Db) => Promise<CommandResult>,
  ): Promise<CommandResult & { replayed: boolean }>;
}

export function hashRequest(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');
}

export function createIdempotencyService(): IdempotencyService {
  return {
    execute(db, { key, userId, requestHash }, run) {
      return db.transaction(async (tx) => {
        const existing = await findIdempotent(tx, key, userId);
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new RuleViolationError(
              'idempotency_key_reused',
              'This Idempotency-Key was already used for a different request',
            );
          }
          return { statusCode: existing.status_code, body: existing.response, replayed: true };
        }
        const result = await run(tx);
        await storeIdempotent(tx, {
          key,
          user_id: userId,
          request_hash: requestHash,
          response: result.body,
          status_code: result.statusCode,
        });
        return { ...result, replayed: false };
      });
    },
  };
}
