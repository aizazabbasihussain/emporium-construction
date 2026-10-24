import { createHash } from 'node:crypto';
import multipart from '@fastify/multipart';
import { ValidationError } from '@emporium/domain';
import { MAX_FILE_BYTES } from '@emporium/domain/files';
import { filesPermissions } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Files } from '../index.js';
import type { LocalFileStore } from '../store/local.store.js';
import type { Db, FileActor } from '../types.js';

export interface FilesRouteDeps {
  db: Db;
  files: Files;
  platform: Platform;
  /** The local driver, when selected: it serves the signed links it issues. */
  local?: LocalFileStore | undefined;
}

const entityType = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({ entityType, entityId: z.uuid() });
const removeQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const tokenQuery = z.object({ token: z.string().min(1).max(2048) });
const uploadFields = z.object({
  entityType,
  entityId: z.uuid(),
  caption: z.string().max(500).optional(),
  takenAt: z.iso.datetime({ offset: true }).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});

interface CommandResult {
  statusCode: number;
  body: unknown;
}

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

const actorOf = (request: FastifyRequest): FileActor => {
  const user = currentUser(request);
  return {
    userId: user.userId,
    roles: user.roles,
    scopes: user.scopes,
    permissions: user.permissions,
    requestId: request.id,
  };
};

/** The download endpoint of the local driver. The browser opens the signed link without credentials,
 * so the route opts out of the bearer-token hook; the signature is the credential. */
export function registerFileBlobRoute(app: FastifyInstance, local: LocalFileStore): void {
  app.get('/files/blob', { config: { public: true } }, async (request, reply) => {
    const { token } = tokenQuery.parse(request.query);
    const download = await local.read(token);
    const inline =
      download.contentType.startsWith('image/') || download.contentType === 'application/pdf';
    return reply
      .header('content-type', download.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
      )
      .send(Buffer.from(download.bytes));
  });
}

/** The file endpoints (spec P1-04 section 5). */
export async function registerFilesRoutes(
  app: FastifyInstance,
  deps: FilesRouteDeps,
): Promise<void> {
  const { db, files, platform } = deps;
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 8 } });

  /** One transaction per command; with an Idempotency-Key header a retry replays the first response. */
  const command = async (
    request: FastifyRequest,
    reply: FastifyReply,
    run: (tx: Db) => Promise<CommandResult>,
  ) => {
    const key = request.headers['idempotency-key'];
    if (Array.isArray(key) || key === '') {
      throw new ValidationError(
        'invalid_idempotency_key',
        'Idempotency-Key must be a single value',
      );
    }
    const result =
      key === undefined
        ? await db.transaction(run)
        : await platform.idempotency.execute(
            db,
            {
              key,
              userId: currentUser(request).userId,
              requestHash: hashRequest(request.method, request.url, request.body),
            },
            run,
          );
    return reply.status(result.statusCode).send(result.body);
  };

  app.post(
    '/files',
    { preHandler: requirePermission(filesPermissions.upload) },
    async (request, reply) => {
      const fields: Record<string, string> = {};
      let file: { name: string; bytes: Buffer } | undefined;
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value);
        } else {
          try {
            file = { name: part.filename, bytes: await part.toBuffer() };
          } catch (error) {
            if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
              throw new ValidationError('file_too_large', 'The file is larger than 10 MB');
            }
            throw error;
          }
        }
      }
      if (file === undefined) throw new ValidationError('file_required', 'A file is required');
      const input = uploadFields.parse(fields);
      const result = await db.transaction((tx) =>
        files.attach(
          {
            entityType: input.entityType,
            entityId: input.entityId,
            fileName: file.name,
            bytes: file.bytes,
            caption: input.caption ?? null,
            takenAt: input.takenAt === undefined ? null : new Date(input.takenAt),
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
          },
          actorOf(request),
          tx,
        ),
      );
      // BR-2: a retry of the same bytes answers 200 with the existing attachment.
      return reply.status(result.created ? 201 : 200).send(result.attachment);
    },
  );

  app.get('/files', { preHandler: requirePermission(filesPermissions.read) }, async (request) => {
    const query = listQuery.parse(request.query);
    return {
      items: await files.list(db, actorOf(request), query.entityType, query.entityId),
    };
  });

  app.get(
    '/files/:id/url',
    { preHandler: requirePermission(filesPermissions.read) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return files.getSignedUrl(db, actorOf(request), id);
    },
  );

  app.delete(
    '/files/:id',
    { preHandler: requirePermission(filesPermissions.remove) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const query = removeQuery.parse(request.query);
      return command(request, reply, async (tx) => ({
        statusCode: 200,
        body: await files.remove(id, actorOf(request), tx, query.version),
      }));
    },
  );
}
