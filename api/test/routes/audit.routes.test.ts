import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { User } from '../../src/models/User';
import { Order } from '../../src/models/Order';
import { AuditLog } from '../../src/models/AuditLog';

let replSet: MongoMemoryReplSet;
const app = createApp();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('audit_routes_test'));
  await bootstrap(replSet.getUri('audit_routes_test'), () => {});
}, 180_000);

afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

beforeEach(async () => {
  await Order.deleteMany({});
  await User.deleteMany({});
  await AuditLog.deleteMany({});
});

async function signupAndLogin(email: string): Promise<string[]> {
  await request(app).post('/api/v1/auth/signup').send({ email, password: 'password123' });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'password123' });
  return res.headers['set-cookie'] as unknown as string[];
}

async function createSampleOrder(cookie: string[]) {
  const res = await request(app)
    .post('/api/v1/orders')
    .set('Cookie', cookie)
    .send({ customer: 'Acme Corp', dueDate: '2026-08-20', lineItems: [{ description: 'Widget', quantity: 2, unitPriceCents: 50_000 }] });
  return res.body._id as string;
}

describe('GET /api/v1/orders/:id/audit', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/orders/000000000000000000000000/audit');
    expect(res.status).toBe(401);
  });

  it('returns the order-scoped trail newest first', async () => {
    const cookie = await signupAndLogin('a@example.com');
    const orderId = await createSampleOrder(cookie);

    await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 40_000, paidOn: '2026-08-01', idempotencyKey: 'k1' });

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      'payment.recorded',
      'order.created',
    ]);

    const [payment] = res.body.entries;
    expect(payment.delta.amountCents).toBe(40_000);
    expect(payment.snapshot.amountPaidCents).toBe(40_000);
    expect(typeof payment.at).toBe('string');
  });

  it('records a refused over-payment, so the trail shows what was attempted', async () => {
    const cookie = await signupAndLogin('b@example.com');
    const orderId = await createSampleOrder(cookie);

    const rejected = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 500_000, paidOn: '2026-08-01', idempotencyKey: 'k2' });
    expect(rejected.status).toBe(409); // OVERPAYMENT

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);

    const entry = res.body.entries.find((e: { action: string }) => e.action === 'payment.rejected');
    expect(entry).toBeDefined();
    expect(entry.delta.attemptedCents).toBe(500_000);
    expect(entry.delta.maxAllowedCents).toBe(100_000);
  });

  it("never exposes the actor's IP or user agent", async () => {
    const cookie = await signupAndLogin('c@example.com');
    const orderId = await createSampleOrder(cookie);

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);

    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const entry of res.body.entries) {
      expect(entry).not.toHaveProperty('actor');
      expect(JSON.stringify(entry)).not.toContain('userAgent');
    }
  });

  it('records what an edited field changed FROM, not just what it became', async () => {
    const cookie = await signupAndLogin('d@example.com');
    const orderId = await createSampleOrder(cookie);

    await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ customer: 'Globex Corp', dueDate: '2026-09-30' });

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);
    const updated = res.body.entries.find((e: { action: string }) => e.action === 'order.updated');

    expect(updated.delta.changes.customer).toEqual({ from: 'Acme Corp', to: 'Globex Corp' });
    expect(updated.delta.changes.dueDate.from).toContain('2026-08-20');
    expect(updated.delta.changes.dueDate.to).toContain('2026-09-30');
  });

  it('records a line-item edit that leaves the count and total untouched', async () => {
    const cookie = await signupAndLogin('h@example.com');
    const orderId = await createSampleOrder(cookie);

    // Description only. Count stays 1 and the total stays $1,000 — comparing just those two
    // would see nothing, leaving an "Order updated" row that can't say what changed.
    await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ lineItems: [{ description: 'Widget Pro', quantity: 2, unitPriceCents: 50_000 }] });

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);
    const updated = res.body.entries.find((e: { action: string }) => e.action === 'order.updated');

    expect(updated.delta.changes.lineItems.from.items).toEqual([
      { description: 'Widget', quantity: 2, unitPriceCents: 50_000 },
    ]);
    expect(updated.delta.changes.lineItems.to.items).toEqual([
      { description: 'Widget Pro', quantity: 2, unitPriceCents: 50_000 },
    ]);
    expect(updated.delta.changes.lineItems.to.totalCents).toBe(100_000); // unchanged
  });

  it('records a quantity/price swap that keeps the same total', async () => {
    const cookie = await signupAndLogin('i@example.com');
    const orderId = await createSampleOrder(cookie);

    // 2 × $500 becomes 4 × $250 — same $1,000, same one row, genuinely different order.
    await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ lineItems: [{ description: 'Widget', quantity: 4, unitPriceCents: 25_000 }] });

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);
    const updated = res.body.entries.find((e: { action: string }) => e.action === 'order.updated');

    expect(updated.delta.changes).toHaveProperty('lineItems');
    expect(updated.delta.changes.lineItems.to.items[0]).toEqual({
      description: 'Widget',
      quantity: 4,
      unitPriceCents: 25_000,
    });
  });

  it('reports a line-item edit as a count and total on each side', async () => {
    const cookie = await signupAndLogin('e@example.com');
    const orderId = await createSampleOrder(cookie);

    await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({
        lineItems: [
          { description: 'Widget', quantity: 2, unitPriceCents: 50_000 },
          { description: 'Support', quantity: 1, unitPriceCents: 25_000 },
        ],
      });

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);
    const updated = res.body.entries.find((e: { action: string }) => e.action === 'order.updated');

    expect(updated.delta.changes.lineItems).toEqual({
      from: {
        count: 1,
        totalCents: 100_000,
        items: [{ description: 'Widget', quantity: 2, unitPriceCents: 50_000 }],
      },
      to: {
        count: 2,
        totalCents: 125_000,
        items: [
          { description: 'Widget', quantity: 2, unitPriceCents: 50_000 },
          { description: 'Support', quantity: 1, unitPriceCents: 25_000 },
        ],
      },
    });
  });

  it('omits fields the patch named but did not actually change', async () => {
    const cookie = await signupAndLogin('f@example.com');
    const orderId = await createSampleOrder(cookie);

    // Same customer it already has, alongside a due date that genuinely moves.
    await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ customer: 'Acme Corp', dueDate: '2026-09-30' });

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);
    const updated = res.body.entries.find((e: { action: string }) => e.action === 'order.updated');

    expect(updated.delta.changes).not.toHaveProperty('customer');
    expect(updated.delta.changes).toHaveProperty('dueDate');
  });

  it('carries the status as it stood at each event, not as it stands today', async () => {
    const cookie = await signupAndLogin('g@example.com');
    const orderId = await createSampleOrder(cookie);

    await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 40_000, paidOn: '2026-08-01', idempotencyKey: 'k3' });
    await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 60_000, paidOn: '2026-08-02', idempotencyKey: 'k4' });

    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', cookie);
    const statuses = res.body.entries.map((e: { status: string }) => e.status);

    // Newest first: settled, then partway there, then nothing paid at all.
    expect(statuses).toEqual(['paid', 'partially_paid', 'pending']);
  });

  it("404s on someone else's order rather than returning an empty trail", async () => {
    const owner = await signupAndLogin('owner@example.com');
    const orderId = await createSampleOrder(owner);

    const intruder = await signupAndLogin('intruder@example.com');
    const res = await request(app).get(`/api/v1/orders/${orderId}/audit`).set('Cookie', intruder);

    // An empty 200 would confirm the id exists; 404 is indistinguishable from "no such order".
    expect(res.status).toBe(404);
  });
});
