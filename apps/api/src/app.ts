import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import pkg from '../package.json' with { type: 'json' };
import type { AppConfig } from './config.js';
import { registerErrorHandling } from './errors.js';
import { registerIdentityRoutes, type IdentityRouteDeps } from './modules/identity/index.js';
import { registerPlatformRoutes, type PlatformRouteDeps } from './modules/platform/index.js';

export interface AppDeps {
  config: Pick<AppConfig, 'corsOrigins'>;
  logger: Logger;
  clock?: () => Date;
  /** Database, kernel services and caller resolution; the admin routes are mounted only when given. */
  platform?: PlatformRouteDeps;
  /** Authentication and the identity endpoints; when given, every route except /health needs a JWT. */
  identity?: IdentityRouteDeps;
}

export async function buildApp({
  config,
  logger,
  clock = () => new Date(),
  platform,
  identity,
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

  return app;
}
