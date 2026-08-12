import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Types } from 'mongoose';
import { User, type UserDocument } from '../models/User';
import { Session, type SessionDocument } from '../models/Session';
import { AuditLog, type AuditAction } from '../models/AuditLog';
import { LoginAttempt } from '../models/LoginAttempt';
import { ConflictError, UnauthenticatedError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Controllers own HTTP concerns (parsing, cookies, status codes); this module owns the auth
 * domain (passwords, sessions, audit entries) and knows nothing about Express. Nothing here
 * imports `req`/`res`, so it's exercised directly in tests without spinning up the app.
 */

export const SESSION_COOKIE_NAME = 'session';

// bcryptjs is a pure-JS implementation (no native binding), and cost 12 on a throttled
// deployment CPU was measured pushing login past 3s. 7 is a deliberate trade of brute-force
// margin for latency on this host — revisit alongside a move to native bcrypt/argon2 or a
// less CPU-throttled host, since the hash format encodes its own cost, so raising it later
// doesn't require migrating already-stored hashes.
const BCRYPT_COST = 7;

/**
 * Idle window: a session dies after this long with no request, but slides forward on use.
 * 30 minutes rather than something looser — comparable to typical banking-session timeouts,
 * which is the right posture for an app that touches money.
 */
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 min

/**
 * Absolute ceiling: survives sliding, so even a continuously active session eventually ends.
 * This is the only thing that bounds an actively-used STOLEN token — the idle window slides
 * forward on any valid use regardless of who's making the request, so it does nothing against
 * a token an attacker is actively replaying. 24h forces re-authentication at least once a day
 * regardless of activity, capping that exposure instead of leaving it open for a week.
 */
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000; // 24h

/** Don't write to the session on every single request — only once this long has passed. */
const SESSION_SLIDE_THROTTLE_MS = 5 * 60 * 1000; // 5 min

export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min

/**
 * A real bcrypt hash of an unguessable, unused value, computed once at module load rather than
 * hardcoded. `bcrypt.compare()` against this takes the same time as comparing a real user's
 * password, so a login attempt for an email that doesn't exist takes exactly as long as one for
 * an email that does — the response can't be used to enumerate registered accounts.
 */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomUUID(), BCRYPT_COST);

export interface RequestContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * `findOne({ email })` is a literal match against what's stored, and Mongoose's schema-level
 * `lowercase: true` only runs on save — it does NOT normalise a query filter. Skipping this
 * means "Deepak@Example.com" fails to find an account saved as "deepak@example.com".
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Shared by the rate-limit middleware (the pre-check) and login() (recording the outcome) so
 *  the two can never disagree about which bucket an attempt belongs to. */
export function loginRateLimitKey(email: string, ip: string | undefined): string {
  return `${normalizeEmail(email)}:${ip ?? 'unknown'}`;
}

/**
 * The pre-check the rate-limit middleware calls BEFORE the controller (and therefore before
 * bcrypt) ever runs — so an attacker who's already over the limit can't burn server CPU on a
 * bcrypt comparison just to get rejected a moment later.
 */
export async function isLoginRateLimited(key: string): Promise<boolean> {
  const existing = await LoginAttempt.findById(key);
  if (!existing) return false;
  return existing.attempts >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS && existing.expiresAt > new Date();
}

async function recordLoginFailure(key: string): Promise<void> {
  const now = new Date();

  // Atomically increment only if an active window already exists — a document whose window
  // has logically expired but hasn't been TTL-reaped yet must not keep counting against it.
  const incremented = await LoginAttempt.findOneAndUpdate(
    { _id: key, expiresAt: { $gt: now } },
    { $inc: { attempts: 1 } },
  );

  if (!incremented) {
    // No active window — start a fresh one. A concurrent double-failure here could race and
    // briefly mis-count by one; acceptable for a login throttle, unlike the payment guard.
    await LoginAttempt.findOneAndUpdate(
      { _id: key },
      {
        $set: {
          attempts: 1,
          firstAttemptAt: now,
          expiresAt: new Date(now.getTime() + LOGIN_RATE_LIMIT_WINDOW_MS),
        },
      },
      { upsert: true },
    );
  }
}

/** A legitimate user who mistypes twice then gets it right shouldn't carry a lingering count. */
async function clearLoginAttempts(key: string): Promise<void> {
  await LoginAttempt.deleteOne({ _id: key });
}

/**
 * Runs a write the caller doesn't need to wait on — the login response depends on neither
 * the rate-limit bookkeeping nor the audit trail, only on the session existing. Not awaiting
 * these takes them off the request's critical path entirely rather than merely parallelising
 * them; `.catch` exists only so a failed background write logs instead of becoming an unhandled
 * rejection, since nothing downstream is listening for it to reject.
 */
function background(promise: Promise<unknown>, label: string): void {
  void promise.catch((err) => logger.error({ err, label }, 'auth background task failed'));
}

async function recordAudit(
  action: AuditAction,
  opts: { userId?: Types.ObjectId; context?: RequestContext; delta?: Record<string, unknown> },
): Promise<void> {
  await AuditLog.create({
    userId: opts.userId ?? null,
    action,
    requestId: opts.context?.requestId,
    actor: { ip: opts.context?.ip, userAgent: opts.context?.userAgent },
    delta: opts.delta,
  });
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
}

export async function signup(
  input: SignupInput,
  context: RequestContext = {},
): Promise<UserDocument> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  let user: UserDocument;
  try {
    user = await User.create({
      email: normalizeEmail(input.email),
      name: input.name,
      passwordHash,
    });
  } catch (err) {
    // Not a pre-check (findOne then create) — that races under concurrent signups for the same
    // address. The unique index is the actual guard; this just translates its rejection.
    if ((err as { code?: number }).code === 11000) {
      throw new ConflictError('An account with this email already exists', 'email');
    }
    throw err;
  }

  await recordAudit('auth.signup', { userId: user._id, context });
  return user;
}

export interface LoginResult {
  user: UserDocument;
  rawToken: string;
  session: SessionDocument;
}

export async function login(
  email: string,
  password: string,
  context: RequestContext = {},
): Promise<LoginResult> {
  const normalizedEmail = normalizeEmail(email);
  const rateLimitKey = loginRateLimitKey(normalizedEmail, context.ip);

  const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');

  // Compare against DUMMY_HASH when there's no user, so this branch costs the same as the
  // real one — see the comment on DUMMY_HASH for why that matters.
  const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordMatches) {
    background(recordLoginFailure(rateLimitKey), 'recordLoginFailure');
    background(
      recordAudit('auth.login.failed', { context, delta: { email: normalizedEmail } }),
      'recordAudit(auth.login.failed)',
    );
    // Deliberately identical whether the email doesn't exist or the password is wrong.
    throw new UnauthenticatedError('Invalid email or password');
  }

  background(clearLoginAttempts(rateLimitKey), 'clearLoginAttempts');

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  const session = await Session.create({
    _id: hashToken(rawToken),
    userId: user._id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
    lastUsedAt: now,
    ip: context.ip,
    userAgent: context.userAgent,
  });

  background(
    recordAudit('auth.login.succeeded', { userId: user._id, context }),
    'recordAudit(auth.login.succeeded)',
  );
  return { user, rawToken, session };
}

export async function logout(rawToken: string, context: RequestContext = {}): Promise<void> {
  // findOneAndDelete rather than a separate find + delete — one round trip, and it returns the
  // session so the audit entry can carry the userId without a second query.
  const session = await Session.findOneAndDelete({ _id: hashToken(rawToken) });
  if (session) {
    await recordAudit('auth.logout', { userId: session.userId, context });
  }
}

export interface ValidatedSession {
  userId: Types.ObjectId;
}

/**
 * Used by the requireAuth middleware on every authenticated request. Enforces both expiries and
 * slides the idle window forward — throttled, so an active user doesn't cause a write on every
 * single request.
 */
export async function validateSession(rawToken: string): Promise<ValidatedSession | null> {
  const tokenHash = hashToken(rawToken);
  const session = await Session.findById(tokenHash);
  if (!session) return null;

  const now = new Date();

  if (now > session.absoluteExpiresAt || now > session.expiresAt) {
    await Session.deleteOne({ _id: tokenHash });
    return null;
  }

  if (now.getTime() - session.lastUsedAt.getTime() > SESSION_SLIDE_THROTTLE_MS) {
    await Session.updateOne(
      { _id: tokenHash },
      { $set: { expiresAt: new Date(now.getTime() + SESSION_IDLE_MS), lastUsedAt: now } },
    );
  }

  return { userId: session.userId };
}

/** "Sign out everywhere" — every session for the user dies, not just the current one. */
export async function revokeAllSessions(userId: Types.ObjectId): Promise<void> {
  await Session.deleteMany({ userId });
}
