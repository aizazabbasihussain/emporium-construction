import { buildApp } from './app.js';
import { createRuntime } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startScheduler } from './scheduler.js';
import { currentUser } from './modules/identity/index.js';

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const runtime = await createRuntime(config);
  const {
    db,
    identity,
    importer,
    masterData,
    crm,
    valuation,
    estimation,
    quotations,
    projects,
    variations,
    procurement,
    inventory,
    expenses,
    dpr,
    workforce,
    approvals,
    files,
    localFileStore,
    notifications,
    platform,
  } = runtime;
  const app = await buildApp({
    config,
    logger,
    identity: { db, identity },
    platform: { db, platform, resolvePrincipal: currentUser },
    importer: { db, importer },
    approvals: { db, approvals, platform },
    files: { db, files, platform, local: localFileStore },
    notifications: { db, notifications, platform },
    masterData: { db, masterData, platform },
    crm: { db, crm, platform },
    valuation: { db, valuation, platform },
    estimation: { db, estimation, platform },
    quotations: { db, quotations, platform },
    projects: { db, projects, platform },
    variations: { db, variations, platform },
    procurement: { db, procurement, platform },
    inventory: { db, inventory, platform },
    expenses: { db, expenses, platform },
    dpr: { db, dpr, platform },
    workforce: { db, workforce, platform },
  });
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
