import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import pkg from '../package.json' with { type: 'json' };
import type { AppConfig } from './config.js';
import { registerErrorHandling } from './errors.js';
import { registerApprovalsRoutes, type ApprovalsRouteDeps } from './modules/approvals/index.js';
import {
  registerFileBlobRoute,
  registerFilesRoutes,
  type FilesRouteDeps,
} from './modules/files/index.js';
import { registerIdentityRoutes, type IdentityRouteDeps } from './modules/identity/index.js';
import { registerImporterRoutes, type ImporterRouteDeps } from './modules/importer/index.js';
import {
  registerNotificationsRoutes,
  type NotificationsRouteDeps,
} from './modules/notifications/index.js';
import { registerPlatformRoutes, type PlatformRouteDeps } from './modules/platform/index.js';

export interface AppDeps {
  config: Pick<AppConfig, 'corsOrigins'>;
  logger: Logger;
  clock?: () => Date;
  /** Database, kernel services and caller resolution; the admin routes are mounted only when given. */
  platform?: PlatformRouteDeps;
  /** Authentication and the identity endpoints; when given, every route except /health needs a JWT. */
  identity?: IdentityRouteDeps;
  /** The import endpoints; they rely on the authentication hook of `identity`. */
  importer?: ImporterRouteDeps;
  /** The approval endpoints; they rely on the authentication hook of `identity`. */
  approvals?: ApprovalsRouteDeps;
  /** The file endpoints; they rely on the authentication hook of `identity`. */
  files?: FilesRouteDeps;
  /** The notification endpoints; they rely on the authentication hook of `identity`. */
  notifications?: NotificationsRouteDeps;
}

export async function buildApp({
  config,
  logger,
  clock = () => new Date(),
  platform,
  identity,
  importer,
  approvals,
  files,
  notifications,
}: AppDeps): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  await app.register(cors, { origin: config.corsOrigins });

  // Registered before any route so the authentication hook covers all of them (BR-1, AC-1).
  if (identity) registerIdentityRoutes(app, identity);

  app.get('/health', async () => ({
    status: 'ok',
    version: pkg.version,
    time: clock().toISOString(),
  }));

  if (platform) registerPlatformRoutes(app, platform);
  if (importer) registerImporterRoutes(app, importer);
  if (approvals) registerApprovalsRoutes(app, approvals);
  if (files) await registerFilesRoutes(app, files);
  if (files?.local) registerFileBlobRoute(app, files.local);
  if (notifications) registerNotificationsRoutes(app, notifications);

  return app;
}
