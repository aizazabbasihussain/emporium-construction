import multipart from '@fastify/multipart';
import { ValidationError } from '@emporium/domain';
import { MAX_FILE_BYTES, importFormats } from '@emporium/domain/importer';
import { importerPermissions } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Db } from '../../platform/index.js';
import type { Importer } from '../index.js';
import type { FileDownload } from '../types.js';

export interface ImporterRouteDeps {
  db: Db;
  importer: Importer;
}

const codeParams = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]*$/) });
const idParams = z.object({ id: z.uuid() });
const templateQuery = z.object({ format: z.enum(importFormats).default('csv') });
const commitBody = z.object({ force: z.boolean().default(false) }).default({ force: false });
const listQuery = z.object({
  importerCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const send = (reply: FastifyReply, file: FileDownload) =>
  reply
    .header('content-type', file.contentType)
    .header('content-disposition', `attachment; filename="${file.fileName}"`)
    .send(file.body);

/** The importer endpoints (spec P0-04 section 5). Uploaded files are held in memory only (BR-10). */
export function registerImporterRoutes(app: FastifyInstance, deps: ImporterRouteDeps): void {
  const { db, importer } = deps;
  void app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 } });

  const actorOf = (request: FastifyRequest) => ({
    userId: currentUser(request).userId,
    requestId: request.id,
  });

  app.get(
    '/imports/importers',
    { preHandler: requirePermission(importerPermissions.batchRead) },
    async () => ({ items: importer.service.listImporters() }),
  );

  app.get(
    '/imports/importers/:code/template',
    { preHandler: requirePermission(importerPermissions.batchRun) },
    async (request, reply) => {
      const { code } = codeParams.parse(request.params);
      const { format } = templateQuery.parse(request.query);
      return send(reply, await importer.service.template(code, format));
    },
  );

  app.post(
    '/imports/importers/:code/dry-run',
    { preHandler: requirePermission(importerPermissions.batchRun) },
    async (request, reply) => {
      const { code } = codeParams.parse(request.params);
      importer.registry.get(code);
      if (!request.isMultipart()) {
        throw new ValidationError('file_required', 'Upload the file as multipart form data');
      }
      const part = await request.file();
      if (!part) throw new ValidationError('file_required', 'No file was uploaded');
      const content = await part.toBuffer().catch((error: unknown) => {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new ValidationError('file_too_large', 'The file is larger than 10 MB');
        }
        throw error;
      });
      const result = await importer.service.dryRun(
        { importerCode: code, fileName: part.filename, content },
        actorOf(request),
        db,
      );
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/imports/batches/:id/commit',
    { preHandler: requirePermission(importerPermissions.batchRun) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { force } = commitBody.parse(request.body);
      return importer.service.commit(
        id,
        { force, permissions: currentUser(request).permissions },
        actorOf(request),
        db,
      );
    },
  );

  app.get(
    '/imports/batches',
    { preHandler: requirePermission(importerPermissions.batchRead) },
    async (request) => ({
      items: await importer.service.listBatches(db, listQuery.parse(request.query)),
    }),
  );

  app.get(
    '/imports/batches/:id',
    { preHandler: requirePermission(importerPermissions.batchRead) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return importer.service.getBatch(db, id);
    },
  );

  app.get(
    '/imports/batches/:id/errors.csv',
    { preHandler: requirePermission(importerPermissions.batchRead) },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      return send(reply, await importer.service.errorsCsv(db, id));
    },
  );
}
