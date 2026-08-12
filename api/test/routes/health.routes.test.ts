import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';

let replSet: MongoMemoryReplSet;
const app = createApp();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('health_routes_test'));
}, 180_000);

afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

describe('GET /api/v1/health', () => {
  it('reports ok without requiring authentication', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'orders-and-settlements-api' });
  });

  it('does not require a session', async () => {
    // No .set('Cookie', ...) at all — liveness must never depend on auth.
    const res = await request(app).get('/api/v1/health');
    expect(res.status).not.toBe(401);
  });
});

describe('GET /api/v1/ready', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await request(app).get('/api/v1/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'orders-and-settlements-api' });
  });

  it('does not require a session', async () => {
    const res = await request(app).get('/api/v1/ready');
    expect(res.status).not.toBe(401);
  });
});
