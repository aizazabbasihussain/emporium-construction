import { buildApp } from './app.js';
import { createRuntime } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { currentUser } from './modules/identity/index.js';

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const { db, identity, importer, platform } = await createRuntime(config);
  const app = await buildApp({
    config,
    logger,
    identity: { db, identity },
    platform: { db, platform, resolvePrincipal: currentUser },
    importer: { db, importer },
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
}
