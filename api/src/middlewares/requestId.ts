import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * First middleware in the chain (see app.ts) — every request gets an id before anything else
 * runs, so it's available to error responses and log lines regardless of where a request fails.
 * Echoed back as a header so a client can quote it when reporting an issue.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
