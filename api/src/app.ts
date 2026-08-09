import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import routes from './routes';

/**
 * Builds the Express app WITHOUT calling listen().
 *
 * Keeping those apart lets supertest drive the real app in-process during tests — no port
 * binding, no teardown races, no collision with a running dev server. `index.ts` is the only
 * place that listens.
 */
export function createApp(): Express {
  const app = express();

  // Security response headers: HSTS, nosniff, referrer policy, frame options, and it drops
  // the X-Powered-By: Express banner.
  app.use(helmet());

  // In production the browser talks to the Next frontend, which proxies here server-side.
  // CORS matters for direct API access during development and for curl-ing the deployed API.
  app.use(
    cors({
      origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
      credentials: true,
    }),
  );

  // Nothing this API accepts is large, and an unbounded body is a free denial of service.
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/v1', routes);

  return app;
}
