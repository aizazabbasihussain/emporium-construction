import { buildApp } from './app.js';
import { createRuntime, routeDeps } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startScheduler } from './scheduler.js';

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const runtime = await createRuntime(config);
  const app = await buildApp({ config, logger, ...routeDeps(runtime) });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  startScheduler(runtime, logger);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
}
