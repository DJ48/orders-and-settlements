import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import routes from './routes';
import { requestId } from './middlewares/requestId';
import { errorHandler } from './middlewares/errorHandler';
import { logger } from './config/logger';

/**
 * Builds the Express app WITHOUT calling listen().
 *
 * Keeping those apart lets supertest drive the real app in-process during tests — no port
 * binding, no teardown races, no collision with a running dev server. `index.ts` is the only
 * place that listens.
 */
export function createApp(): Express {
  const app = express();

  // First in the chain — every request gets an id before anything else can reject it.
  app.use(requestId);

  // Structured request logging. genReqId reuses the id the middleware above just set, rather
  // than pino-http minting its own — so the same id ties together the response header, the
  // error envelope, the audit-log entry, and every log line for one request. Health checks are
  // excluded: an uptime pinger hitting /health every few minutes would otherwise drown out
  // everything else in the log.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: {
        ignore: (req) => req.url === '/api/v1/health' || req.url === '/api/v1/ready',
      },
    }),
  );

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

  // Must be last — Express identifies an error handler purely by its four-argument arity, so
  // anything registered after this that isn't shaped (err, req, res, next) would never see a
  // thrown or rejected error.
  app.use(errorHandler);

  return app;
}
