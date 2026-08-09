import { createApp } from './app';

/**
 * The only place that binds a port. Everything else imports `createApp` so it can be driven
 * in-process by tests.
 */
const port = Number(process.env.PORT ?? 4000);

const server = createApp().listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

// Render (and any container platform) sends SIGTERM before replacing an instance. Closing the
// server lets in-flight requests finish instead of being cut off mid-payment.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
