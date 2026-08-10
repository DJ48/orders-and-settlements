import { createApp } from './app';
import { connectDatabase } from './config/database';
import { env } from './config/env';

/**
 * The only place that binds a port. Everything else imports `createApp` so it can be driven
 * in-process by tests — which is also why this file, not app.ts, is the one that connects to
 * the database: tests call `connectDatabase()` themselves in their own setup and never run this
 * file at all.
 *
 * The connection is awaited BEFORE the server starts accepting requests. Without this, Mongoose
 * silently buffers every query until a connection exists, and any request arriving before one
 * does fails after a 10s buffering timeout instead of a clear startup error.
 */
async function main(): Promise<void> {
  await connectDatabase(env.MONGODB_URI);

  const server = createApp().listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
  });

  // Render (and any container platform) sends SIGTERM before replacing an instance. Closing the
  // server lets in-flight requests finish instead of being cut off mid-payment.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`${signal} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
