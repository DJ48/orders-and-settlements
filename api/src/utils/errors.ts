import type { ZodError } from 'zod';
import { formatCents } from './money';

/**
 * Every thrown error in the app is one of these, so a single Express error-handling middleware
 * (middlewares/errorHandler.ts) can turn any of them into the same response shape without each
 * controller building its own JSON.
 *
 * Codes are a closed set on purpose — an open string would let a typo silently become a new,
 * undocumented code that no client can match against.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'OVERPAYMENT'
  | 'ORDER_LOCKED'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'RATE_LIMITED'
  | 'CONFLICT';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly field?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The wire format: `{ error: { code, message, field?, requestId?, details? } }`. */
  toJSON(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field !== undefined && { field: this.field }),
        ...(requestId !== undefined && { requestId }),
        ...(this.details !== undefined && { details: this.details }),
      },
    };
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, field?: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', message, field, details);
  }

  /**
   * Reports the first zod issue as the primary field/message — the envelope's `field` is
   * singular — and, when there's more than one, includes the rest under `details.issues` so
   * nothing is silently dropped.
   */
  static fromZodError(error: ZodError): ValidationError {
    const [first, ...rest] = error.issues;
    const field = first ? first.path.join('.') || undefined : undefined;

    return new ValidationError(
      first?.message ?? 'Invalid request',
      field,
      rest.length > 0
        ? { issues: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }
        : undefined,
    );
  }
}

/**
 * Deliberately generic — used both for "no session" and "session expired/revoked", so a client
 * can't distinguish those cases and infer anything about why access was lost.
 */
export class UnauthenticatedError extends ApiError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

/**
 * Used for both "doesn't exist" and "belongs to another user" — ownership checks live in the
 * query predicate (`findOne({ _id, userId })`), so the service layer can't tell the two apart,
 * and the API deliberately doesn't leak which order IDs exist for someone else.
 */
export class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

/** Generic conflict — e.g. a duplicate email caught by the unique index, not a pre-check. */
export class ConflictError extends ApiError {
  constructor(message: string, field?: string) {
    super(409, 'CONFLICT', message, field);
  }
}

/** Line items are locked once any payment exists, since changing the total would invalidate it. */
export class OrderLockedError extends ApiError {
  constructor(
    message = 'This order can no longer be edited because a payment has been recorded against it',
  ) {
    super(409, 'ORDER_LOCKED', message);
  }
}

/**
 * `maxAllowedCents` is the actionable hint the brief asks for. It's in both the message (so a
 * plain curl/Postman user sees it without parsing JSON) and `details` (so the frontend can read
 * it directly rather than re-parsing the message string).
 */
export class OverpaymentError extends ApiError {
  constructor(attemptedCents: number, maxAllowedCents: number) {
    super(
      409,
      'OVERPAYMENT',
      `Payment of $${formatCents(attemptedCents)} exceeds the $${formatCents(maxAllowedCents)} still due on this order.`,
      'amountCents',
      { attemptedCents, maxAllowedCents },
    );
  }
}

export class RateLimitedError extends ApiError {
  constructor(message = 'Too many attempts. Please try again later.') {
    super(429, 'RATE_LIMITED', message);
  }
}
