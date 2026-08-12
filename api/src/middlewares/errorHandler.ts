import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/errors';

/**
 * The single place a thrown error becomes the documented response envelope. Registered last in
 * app.ts — Express recognises an error handler purely by its four-argument arity, so anything
 * registered after this that isn't shaped (err, req, res, next) would never run for a thrown or
 * rejected error. Express 5 forwards rejected promises from async middleware/handlers to this
 * automatically, so a controller can simply `throw` rather than call `next(err)` itself.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // Required for Express to recognise this as error-handling middleware, even though unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json(err.toJSON(req.requestId));
    return;
  }

  // Not one of ours — an actual bug. Logged with full detail server-side via req.log (pino-http's
  // per-request child logger, already carrying requestId — see app.ts); the client gets nothing
  // that could leak internals (stack traces, driver error text). `err` as the key name matters:
  // pino's standard error serializer only formats the stack trace when the property is called
  // exactly that.
  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId: req.requestId,
    },
  });
}
