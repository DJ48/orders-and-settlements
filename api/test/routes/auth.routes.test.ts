import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { User } from '../../src/models/User';
import { Session } from '../../src/models/Session';
import { LoginAttempt } from '../../src/models/LoginAttempt';
import { LOGIN_RATE_LIMIT_MAX_ATTEMPTS } from '../../src/services/auth.service';

/**
 * Exercises the real HTTP surface with supertest, rather than calling auth.service directly —
 * this is what proves zod validation, cookie handling, the rate-limit middleware, and the
 * error-envelope wiring all actually connect the way the unit-level tests assume.
 */
let replSet: MongoMemoryReplSet;
const app = createApp();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('auth_routes_test'));
  await bootstrap(replSet.getUri('auth_routes_test'), () => {});
}, 180_000);

afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Session.deleteMany({});
  await LoginAttempt.deleteMany({});
});

describe('POST /api/v1/auth/signup', () => {
  it('creates an account and never returns the password hash', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'a@example.com' });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('rejects an invalid email with the documented envelope', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.field).toBe('email');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('rejects a password under 8 characters', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'b@example.com', password: 'short' });

    expect(res.status).toBe(400);
  });

  it('returns 409 for a duplicate email', async () => {
    await request(app).post('/api/v1/auth/signup').send({ email: 'dup@example.com', password: 'password123' });
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'dup@example.com', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'user@example.com', password: 'correct-password' });
  });

  it('sets an httpOnly session cookie on success', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'correct-password' });

    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0];
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('rejects the wrong password with 401 and a generic message', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it(`rate-limits after ${LOGIN_RATE_LIMIT_MAX_ATTEMPTS} failed attempts`, async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'wrong' });
      expect(res.status).toBe(401); // every one of the allowed attempts still runs normally
    }

    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'wrong' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('a correct login clears the failure count, so a later mistake does not trip the limit early', async () => {
    await request(app).post('/api/v1/auth/login').send({ email: 'user@example.com', password: 'wrong' });
    await request(app).post('/api/v1/auth/login').send({ email: 'user@example.com', password: 'wrong' });
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'correct-password' }); // resets the counter

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'wrong' });

    expect(res.status).toBe(401); // not 429 — the earlier failures no longer count
  });
});

describe('GET /api/v1/auth/me', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user for a valid session cookie', async () => {
    await request(app).post('/api/v1/auth/signup').send({ email: 'me@example.com', password: 'password123' });
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'me@example.com', password: 'password123' });

    const res = await request(app).get('/api/v1/auth/me').set('Cookie', loginRes.headers['set-cookie']!);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('me@example.com');
  });

  it('rejects a garbage cookie the same way as no cookie at all', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', 'session=not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears the session so /me subsequently requires auth again', async () => {
    await request(app).post('/api/v1/auth/signup').send({ email: 'out@example.com', password: 'password123' });
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'out@example.com', password: 'password123' });
    const cookie = loginRes.headers['set-cookie']!;

    await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(401);
  });

  it('succeeds even with no cookie — logging out an already-expired session is not an error', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
  });
});
