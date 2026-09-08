import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';

const app = createApp();

const server = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`auth-service listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// Without this, a startup failure (most commonly EADDRINUSE — the port
// already in use) surfaces as an unhandled 'error' event on the server
// object rather than a clear message, and the process may not even exit.
server.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});

let shuttingDown = false;

/**
 * On SIGTERM/SIGINT (a container orchestrator stopping this process, or a
 * developer hitting Ctrl+C): stop accepting new connections, let in-flight
 * requests finish, then close the database connection before exiting —
 * rather than the default behavior of the process (and every request it's
 * mid-handling) being killed immediately.
 */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  // eslint-disable-next-line no-console
  console.log(`${signal} received, shutting down gracefully...`);

  server.close(async (closeErr) => {
    if (closeErr) {
      // eslint-disable-next-line no-console
      console.error('Error while closing HTTP server:', closeErr);
    }
    await prisma.$disconnect();
    process.exit(closeErr ? 1 : 0);
  });

  // Backstop: force-exit if something (a stuck in-flight request, a hung DB
  // call) keeps the graceful path from ever completing.
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('Graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
