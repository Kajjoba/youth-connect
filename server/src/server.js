import { createApp } from './app.js';
import { config } from './config.js';
import { closePool, waitForDatabase } from './db.js';

const app = await createApp();

// Fail fast on a bad database URL rather than discovering it on the
// first user request.
// Retries, so a suspended serverless compute is woken rather than
// reported as unreachable. See waitForDatabase in db.js.
try {
  await waitForDatabase();
} catch (error) {
  console.error('[boot] database unreachable:', error.message);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`[boot] YCP API listening on :${config.port} (${config.env})`);
  console.log(`[boot] Level Two features: ${config.features.levelTwo ? 'ON' : 'OFF'}`);
});

/**
 * Graceful shutdown. Render sends SIGTERM on redeploy. Without this, any
 * request in flight is cut off mid-response and any open transaction is
 * abandoned. Draining first is what makes a deploy invisible to users,
 * which is part of the reliability argument.
 */
async function shutdown(signal) {
  console.log(`[shutdown] ${signal} received, draining`);
  server.close(async () => {
    await closePool();
    console.log('[shutdown] complete');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[shutdown] forced after 10s');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection', reason);
});
