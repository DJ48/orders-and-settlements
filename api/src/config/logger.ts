import pino from 'pino';
import { isProduction, isTest } from './env';

/**
 * One shared logger for the whole process. Plain JSON output, not pretty-printed — that's the
 * point of structured logging: a machine-parseable line a log aggregator (or `jq`) can filter
 * on, not terminal-friendly text. `debug` outside production so local `npm run dev` still shows
 * per-request detail; `info` in production to keep noise down; `silent` under the test runner —
 * every route test drives the real `createApp()` through supertest, so without this every one of
 * those requests would print a JSON log line and drown out vitest's own output.
 */
export const logger = pino({
  level: isTest ? 'silent' : isProduction ? 'info' : 'debug',
});
