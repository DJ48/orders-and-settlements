import type { Request, Response, NextFunction } from 'express';
import { isLoginRateLimited, loginRateLimitKey } from '../services/auth.service';
import { RateLimitedError } from '../utils/errors';

/**
 * Runs BEFORE the controller, and therefore before bcrypt — the whole point is that an
 * already-rate-limited attacker gets rejected without the server spending CPU on a hash
 * comparison first. The actual increment/reset happens inside auth.service.login(), since only
 * that function knows whether an attempt succeeded or failed.
 *
 * Reads straight from `req.body` rather than waiting for the controller's zod validation —
 * this must run first, so it tolerates a malformed body rather than assuming it's already clean.
 */
export async function loginRateLimit(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  const key = loginRateLimitKey(email, req.ip);

  if (await isLoginRateLimited(key)) {
    throw new RateLimitedError();
  }

  next();
}
