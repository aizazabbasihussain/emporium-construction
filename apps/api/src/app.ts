import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import pkg from '../package.json' with { type: 'json' };
import type { AppConfig } from './config.js';
import { registerErrorHandling } from './errors.js';
import { registerPlatformRoutes, type PlatformRouteDeps } from './modules/platform/index.js';

export interface AppDeps {
  config: Pick<AppConfig, 'corsOrigins'>;
  logger: Logger;
  clock?: () => Date;
  /** Database, kernel services and caller resolution; the admin routes are mounted only when given. */
  platform?: PlatformRouteDeps;
}

export async function buildApp({
  config,
  logger,
  clock = () => new Date(),
  platform,
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

  app.get('/health', async () => ({
    status: 'ok',
    version: pkg.version,
    time: clock().toISOString(),
  }));

  if (platform) registerPlatformRoutes(app, platform);

  return app;
}
