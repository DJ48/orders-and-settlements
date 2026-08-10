import type { Request, Response } from 'express';
import type { CookieOptions } from 'express';
import { z, ZodError } from 'zod';
import * as authService from '../services/auth.service';
import { User } from '../models/User';
import { ValidationError, UnauthenticatedError } from '../utils/errors';
import { isProduction } from '../config/env';

/**
 * Controllers stay thin: validate with zod, call a service, shape the response. No Mongoose
 * queries beyond the one direct lookup /me needs, no password/session logic — that all lives in
 * auth.service.ts, which knows nothing about Express and is tested without one.
 */

const SignupSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  // Length only, no forced character-class rules — current OWASP guidance prefers length over
  // composition requirements, which mostly just push users toward predictable substitutions.
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
  name: z.string().trim().max(120).optional(),
});

const LoginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw ValidationError.fromZodError(result.error as ZodError);
  return result.data;
}

function requestContext(req: Request): authService.RequestContext {
  return { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId };
}

interface UserResponse {
  _id: string;
  email: string;
  name?: string;
}

function toUserResponse(user: { _id: { toString(): string }; email: string; name?: string | null }): UserResponse {
  return {
    _id: user._id.toString(),
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
  };
}

/**
 * `SameSite=Lax` unconditionally now — the browser only ever talks to web's own origin, which
 * proxies /api/* to this service server-side (see web/next.config.ts). That makes the session
 * cookie an ordinary first-party cookie regardless of environment, rather than a cross-site one
 * that needs `None; Secure` and is subject to third-party-cookie blocking (Safari/Brave block
 * that by default; it's exactly what caused login to "succeed" while the very next
 * cookie-reading request came back unauthenticated).
 *
 * `secure` stays environment-aware: browsers reject a `Secure` cookie sent over plain HTTP,
 * and local dev runs over HTTP while production is always HTTPS.
 */
const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  maxAge: authService.SESSION_ABSOLUTE_MS,
};

export async function postSignup(req: Request, res: Response): Promise<void> {
  const input = parse(SignupSchema, req.body);
  const user = await authService.signup(input, requestContext(req));
  res.status(201).json(toUserResponse(user));
}

export async function postLogin(req: Request, res: Response): Promise<void> {
  const input = parse(LoginSchema, req.body);
  const { user, rawToken } = await authService.login(
    input.email,
    input.password,
    requestContext(req),
  );

  res.cookie(authService.SESSION_COOKIE_NAME, rawToken, SESSION_COOKIE_OPTIONS);
  res.status(200).json(toUserResponse(user));
}

export async function postLogout(req: Request, res: Response): Promise<void> {
  const rawToken = req.cookies?.[authService.SESSION_COOKIE_NAME];

  // Deliberately not gated behind requireAuth: a client with an already-expired or invalid
  // cookie should still be able to "log out" cleanly rather than being told it's unauthenticated
  // when clearing the session is precisely what it's trying to do.
  if (typeof rawToken === 'string') {
    await authService.logout(rawToken, requestContext(req));
  }

  res.clearCookie(authService.SESSION_COOKIE_NAME, { path: '/' });
  res.status(204).end();
}

export async function getMe(req: Request, res: Response): Promise<void> {
  // requireAuth has already validated the session and attached req.user by this point.
  const user = await User.findById(req.user?.id);
  if (!user) {
    // The session is valid but the account it points at is gone — treat it as logged out
    // rather than as a server error.
    throw new UnauthenticatedError();
  }

  res.json(toUserResponse(user));
}
