import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  ValidationError,
  UnauthenticatedError,
  NotFoundError,
  ConflictError,
  OrderLockedError,
  OverpaymentError,
  RateLimitedError,
} from '../../src/utils/errors';

describe('ApiError.toJSON', () => {
  it('produces the documented envelope shape', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'bad input', 'email', { hint: 'x' });
    expect(err.toJSON('req-1')).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        field: 'email',
        requestId: 'req-1',
        details: { hint: 'x' },
      },
    });
  });

  it('omits field, requestId, and details when absent rather than including them as undefined', () => {
    const err = new ApiError(500, 'VALIDATION_ERROR', 'oops');
    const json = err.toJSON();
    expect(json).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'oops' } });
    expect('field' in json.error).toBe(false);
    expect('requestId' in json.error).toBe(false);
  });

  it('carries the right HTTP status per subclass', () => {
    expect(new ValidationError('x').statusCode).toBe(400);
    expect(new UnauthenticatedError().statusCode).toBe(401);
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new ConflictError('x').statusCode).toBe(409);
    expect(new OrderLockedError().statusCode).toBe(409);
    expect(new OverpaymentError(100, 0).statusCode).toBe(409);
    expect(new RateLimitedError().statusCode).toBe(429);
  });
});

describe('ValidationError.fromZodError', () => {
  const schema = z.object({ email: z.string().email(), amount: z.number().positive() });

  it('surfaces the first issue as the primary field and message', () => {
    const result = schema.safeParse({ email: 'not-an-email', amount: 5 });
    if (result.success) throw new Error('expected failure');

    const err = ValidationError.fromZodError(result.error);
    expect(err.field).toBe('email');
    expect(err.details).toBeUndefined();
  });

  it('keeps every issue under details.issues when there is more than one', () => {
    const result = schema.safeParse({ email: 'not-an-email', amount: -5 });
    if (result.success) throw new Error('expected failure');

    const err = ValidationError.fromZodError(result.error);
    const issues = err.details?.issues as Array<{ field: string }>;
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.field)).toEqual(['email', 'amount']);
  });
});

describe('NotFoundError', () => {
  it('carries no information distinguishing "missing" from "not yours" — ownership is opaque', () => {
    const err = new NotFoundError();
    expect(err.toJSON()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
});

describe('OverpaymentError', () => {
  it("states the brief's required actionable hint in both message and details", () => {
    const err = new OverpaymentError(100, 0); // the brief's own "attempt $1 more" scenario
    expect(err.message).toBe('Payment of $1.00 exceeds the $0.00 still due on this order.');
    expect(err.field).toBe('amountCents');
    expect(err.details).toEqual({ attemptedCents: 100, maxAllowedCents: 0 });
  });

  it('formats partial amounts correctly, not just whole dollars', () => {
    const err = new OverpaymentError(60_050, 60_000);
    expect(err.message).toContain('$600.50');
    expect(err.message).toContain('$600.00');
  });
});
