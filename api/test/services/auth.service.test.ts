import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { User } from '../../src/models/User';
import { Session } from '../../src/models/Session';
import { AuditLog } from '../../src/models/AuditLog';
import {
  signup,
  login,
  logout,
  validateSession,
  revokeAllSessions,
  SESSION_ABSOLUTE_MS,
} from '../../src/services/auth.service';
import { ConflictError, UnauthenticatedError } from '../../src/utils/errors';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('auth_test'));
  // Duplicate-email rejection depends on the unique index actually existing.
  await bootstrap(replSet.getUri('auth_test'), () => {});
}, 180_000);

afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Session.deleteMany({});
  await AuditLog.deleteMany({});
});

describe('signup', () => {
  it('creates a user with a hashed password, never the plaintext', async () => {
    const user = await signup({ email: 'Deepak@Example.com', password: 'correct horse battery' });

    expect(user.email).toBe('deepak@example.com'); // normalised
    const stored = await User.findById(user._id).select('+passwordHash');
    expect(stored?.passwordHash).not.toBe('correct horse battery');
    expect(stored?.passwordHash?.startsWith('$2')).toBe(true); // bcrypt hash prefix
  });

  it('records an audit entry', async () => {
    const user = await signup({ email: 'a@example.com', password: 'password123' });
    const entry = await AuditLog.findOne({ action: 'auth.signup', userId: user._id });
    expect(entry).not.toBeNull();
  });

  it('rejects a duplicate email via the unique index, not a pre-check', async () => {
    await signup({ email: 'dup@example.com', password: 'password123' });
    await expect(signup({ email: 'dup@example.com', password: 'different' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('treats emails as case-insensitive duplicates', async () => {
    await signup({ email: 'case@example.com', password: 'password123' });
    await expect(signup({ email: 'CASE@EXAMPLE.COM', password: 'password123' })).rejects.toThrow(
      ConflictError,
    );
  });
});

describe('login', () => {
  beforeEach(async () => {
    await signup({ email: 'user@example.com', password: 'correct-password' });
  });

  it('succeeds with the right credentials and mints a session', async () => {
    const { user, rawToken, session } = await login('user@example.com', 'correct-password');

    expect(user.email).toBe('user@example.com');
    expect(rawToken).toHaveLength(43); // 32 random bytes, base64url
    expect(session.userId.toString()).toBe(user._id.toString());
    expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(
      SESSION_ABSOLUTE_MS,
    );
  });

  it('is case-insensitive on email', async () => {
    const { user } = await login('USER@EXAMPLE.COM', 'correct-password');
    expect(user.email).toBe('user@example.com');
  });

  it('rejects the wrong password with a generic message', async () => {
    await expect(login('user@example.com', 'wrong-password')).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('rejects a non-existent email with the SAME generic message — no enumeration', async () => {
    let unknownEmailMessage = '';
    let wrongPasswordMessage = '';

    try {
      await login('nobody@example.com', 'whatever');
    } catch (err) {
      unknownEmailMessage = (err as Error).message;
    }
    try {
      await login('user@example.com', 'wrong-password');
    } catch (err) {
      wrongPasswordMessage = (err as Error).message;
    }

    expect(unknownEmailMessage).toBe(wrongPasswordMessage);
  });

  it('throws UnauthenticatedError specifically, not a generic Error', async () => {
    await expect(login('nobody@example.com', 'whatever')).rejects.toThrow(UnauthenticatedError);
  });

  it('records success and failure audit entries distinctly', async () => {
    await login('user@example.com', 'correct-password').catch(() => {});
    await login('user@example.com', 'wrong-password').catch(() => {});

    expect(await AuditLog.countDocuments({ action: 'auth.login.succeeded' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'auth.login.failed' })).toBe(1);
  });
});

describe('logout', () => {
  it('deletes the session so it can no longer be validated', async () => {
    await signup({ email: 'x@example.com', password: 'password123' });
    const { rawToken } = await login('x@example.com', 'password123');

    expect(await validateSession(rawToken)).not.toBeNull();
    await logout(rawToken);
    expect(await validateSession(rawToken)).toBeNull();
  });

  it('does not throw when given a token with no matching session', async () => {
    await expect(logout('not-a-real-token')).resolves.toBeUndefined();
  });
});

describe('validateSession', () => {
  it('returns the userId for a valid session', async () => {
    const user = await signup({ email: 'y@example.com', password: 'password123' });
    const { rawToken } = await login('y@example.com', 'password123');

    const result = await validateSession(rawToken);
    expect(result?.userId.toString()).toBe(user._id.toString());
  });

  it('returns null for an unknown token', async () => {
    expect(await validateSession('totally-made-up')).toBeNull();
  });

  it('expires and deletes a session past its idle window', async () => {
    await signup({ email: 'z@example.com', password: 'password123' });
    const { rawToken, session } = await login('z@example.com', 'password123');

    // Simulate time passing without a real 30-minute wait.
    await Session.updateOne({ _id: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await validateSession(rawToken)).toBeNull();
    expect(await Session.findById(session._id)).toBeNull(); // actually deleted, not just ignored
  });

  it('expires past the absolute ceiling even if the idle window was just slid', async () => {
    await signup({ email: 'w@example.com', password: 'password123' });
    const { rawToken, session } = await login('w@example.com', 'password123');

    await Session.updateOne(
      { _id: session._id },
      {
        $set: {
          expiresAt: new Date(Date.now() + 1_000_000), // idle window still "fresh"
          absoluteExpiresAt: new Date(Date.now() - 1000), // but the hard cap has passed
        },
      },
    );

    expect(await validateSession(rawToken)).toBeNull();
  });

  it('slides the idle window forward once the throttle window has passed', async () => {
    await signup({ email: 'slide@example.com', password: 'password123' });
    const { rawToken, session } = await login('slide@example.com', 'password123');

    const staleLastUsed = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago > 5 min throttle
    await Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: staleLastUsed } });

    await validateSession(rawToken);

    const updated = await Session.findById(session._id);
    expect(updated?.lastUsedAt.getTime()).toBeGreaterThan(staleLastUsed.getTime());
    expect(updated?.expiresAt.getTime()).toBeGreaterThan(session.expiresAt.getTime());
  });
});

describe('revokeAllSessions', () => {
  it('deletes every session for the user, and only that user', async () => {
    const user = await signup({ email: 'multi@example.com', password: 'password123' });
    await signup({ email: 'other@example.com', password: 'password123' });

    await login('multi@example.com', 'password123');
    await login('multi@example.com', 'password123'); // two devices
    const { rawToken: otherToken } = await login('other@example.com', 'password123');

    expect(await Session.countDocuments({ userId: user._id })).toBe(2);

    await revokeAllSessions(user._id);

    expect(await Session.countDocuments({ userId: user._id })).toBe(0);
    expect(await validateSession(otherToken)).not.toBeNull(); // untouched
  });
});
