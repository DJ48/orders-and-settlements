import type { Request, Response, NextFunction } from 'express';
import { validateSession, SESSION_COOKIE_NAME } from '../services/auth.service';
import { UnauthenticatedError } from '../utils/errors';

/**
 * Every protected route applies this directly rather than trusting a flag set upstream — a
 * "logged in" check that lived somewhere else is exactly the kind of thing a new route can
 * accidentally forget to wire up. This is the one place `req.user` gets set.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof rawToken !== 'string') {
    throw new UnauthenticatedError();
  }

  const session = await validateSession(rawToken);
  if (!session) {
    throw new UnauthenticatedError();
  }

  req.user = { id: session.userId };
  next();
}
