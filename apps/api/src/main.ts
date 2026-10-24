import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const app = await buildApp({ config, logger });
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
}
