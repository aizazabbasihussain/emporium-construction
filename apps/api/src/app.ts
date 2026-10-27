import { randomUUID } from 'node:crypto';
import { MAX_FILE_BYTES } from '@emporium/domain/files';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
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
import { registerCrmRoutes, type CrmRouteDeps } from './modules/crm/index.js';
import { registerEstimationRoutes, type EstimationRouteDeps } from './modules/estimation/index.js';
import { registerIdentityRoutes, type IdentityRouteDeps } from './modules/identity/index.js';
import { registerImporterRoutes, type ImporterRouteDeps } from './modules/importer/index.js';
import { registerMasterDataRoutes, type MasterDataRouteDeps } from './modules/masterdata/index.js';
import { registerProjectsRoutes, type ProjectsRouteDeps } from './modules/projects/index.js';
import { registerQuotationsRoutes, type QuotationsRouteDeps } from './modules/quotations/index.js';
import {
  registerNotificationsRoutes,
  type NotificationsRouteDeps,
} from './modules/notifications/index.js';
import { registerPlatformRoutes, type PlatformRouteDeps } from './modules/platform/index.js';
import {
  registerProcurementRoutes,
  type ProcurementRouteDeps,
} from './modules/procurement/index.js';
import { registerVariationsRoutes, type VariationsRouteDeps } from './modules/variations/index.js';
import { registerValuationRoutes, type ValuationRouteDeps } from './modules/valuation/index.js';

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
  /** The master data endpoints; they rely on the authentication hook of `identity`. */
  masterData?: MasterDataRouteDeps;
  /** The CRM endpoints; they rely on the authentication hook of `identity`. */
  crm?: CrmRouteDeps;
  /** The valuation endpoints; they rely on the authentication hook of `identity`. */
  valuation?: ValuationRouteDeps;
  /** The estimation endpoints; they rely on the authentication hook of `identity`. */
  estimation?: EstimationRouteDeps;
  /** The quotation endpoints; they rely on the authentication hook of `identity`. */
  quotations?: QuotationsRouteDeps;
  /** The project endpoints; they rely on the authentication hook of `identity`. */
  projects?: ProjectsRouteDeps;
  /** The variation endpoints; they rely on the authentication hook of `identity`. */
  variations?: VariationsRouteDeps;
  /** The procurement endpoints; they rely on the authentication hook of `identity`. */
  procurement?: ProcurementRouteDeps;
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
  masterData,
  crm,
  valuation,
  estimation,
  quotations,
  projects,
  variations,
  procurement,
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
  // One registration for every upload route (importer, files); the plugin can only be added once.
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 8 } });

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
  if (masterData) registerMasterDataRoutes(app, masterData);
  if (crm) registerCrmRoutes(app, crm);
  if (valuation) registerValuationRoutes(app, valuation);
  if (estimation) registerEstimationRoutes(app, estimation);
  if (quotations) registerQuotationsRoutes(app, quotations);
  if (projects) registerProjectsRoutes(app, projects);
  if (variations) registerVariationsRoutes(app, variations);
  if (procurement) registerProcurementRoutes(app, procurement);

  return app;
}
