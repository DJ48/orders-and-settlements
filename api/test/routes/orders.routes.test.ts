import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { User } from '../../src/models/User';
import { Order } from '../../src/models/Order';

let replSet: MongoMemoryReplSet;
const app = createApp();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('orders_routes_test'));
  await bootstrap(replSet.getUri('orders_routes_test'), () => {});
}, 180_000);

afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

beforeEach(async () => {
  await Order.deleteMany({});
  await User.deleteMany({});
});

async function signupAndLogin(email: string): Promise<string[]> {
  await request(app).post('/api/v1/auth/signup').send({ email, password: 'password123' });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'password123' });
  return res.headers['set-cookie'] as unknown as string[];
}

const sampleLineItems = () => [{ description: 'Widget', quantity: 2, unitPriceCents: 50_000 }];

describe('POST /api/v1/orders', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    expect(res.status).toBe(401);
  });

  it("creates an order matching the brief's sample: 2 × $500 = $1,000, due in 7 days", async () => {
    const cookie = await signupAndLogin('a@example.com');
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Cookie', cookie)
      .send({ customer: 'Acme Corp', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      customer: 'Acme Corp',
      totalCents: 100_000,
      amountPaidCents: 0,
      amountDueCents: 100_000,
      status: 'pending',
      paidLate: false,
      canEditLineItems: true,
    });
    expect(res.body.lineItems).toHaveLength(1);
    expect(res.body.payments).toHaveLength(0);
  });

  it('rejects an order with no line items', async () => {
    const cookie = await signupAndLogin('b@example.com');
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Cookie', cookie)
      .send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed date', async () => {
    const cookie = await signupAndLogin('c@example.com');
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Cookie', cookie)
      .send({ customer: 'Acme', dueDate: 'not-a-date', lineItems: sampleLineItems() });

    expect(res.status).toBe(400);
  });

  it('never trusts a client-supplied total', async () => {
    const cookie = await signupAndLogin('d@example.com');
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Cookie', cookie)
      .send({
        customer: 'Acme',
        dueDate: '2026-08-20',
        lineItems: sampleLineItems(),
        totalCents: 1, // ignored — the server recomputes from lineItems regardless
      });

    expect(res.body.totalCents).toBe(100_000);
  });
});

describe('GET /api/v1/orders', () => {
  it("lists only the caller's own orders", async () => {
    const cookieA = await signupAndLogin('e@example.com');
    const cookieB = await signupAndLogin('f@example.com');

    await request(app).post('/api/v1/orders').set('Cookie', cookieA).send({ customer: 'Mine', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await request(app).post('/api/v1/orders').set('Cookie', cookieB).send({ customer: 'Theirs', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const res = await request(app).get('/api/v1/orders').set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].customer).toBe('Mine');
  });

  it('list rows omit lineItems and payments', async () => {
    const cookie = await signupAndLogin('g@example.com');
    await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const res = await request(app).get('/api/v1/orders').set('Cookie', cookie);
    expect(res.body[0].lineItems).toBeUndefined();
    expect(res.body[0].payments).toBeUndefined();
  });

  it('filters by status', async () => {
    const cookie = await signupAndLogin('h@example.com');
    await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const pending = await request(app).get('/api/v1/orders?status=pending').set('Cookie', cookie);
    const paid = await request(app).get('/api/v1/orders?status=paid').set('Cookie', cookie);

    expect(pending.body).toHaveLength(1);
    expect(paid.body).toHaveLength(0);
  });

  it('rejects an invalid status value', async () => {
    const cookie = await signupAndLogin('i@example.com');
    const res = await request(app).get('/api/v1/orders?status=not-a-real-status').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/orders/export', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/orders/export?from=2026-01-01&to=2026-12-31');
    expect(res.status).toBe(401);
  });

  it('is not swallowed by the /:id route', async () => {
    const cookie = await signupAndLogin('export-routing@example.com');
    const res = await request(app).get('/api/v1/orders/export?from=2026-01-01&to=2026-12-31').set('Cookie', cookie);
    expect(res.status).not.toBe(404);
  });

  it('returns a CSV with the right headers and a row per order due inside the range', async () => {
    const cookie = await signupAndLogin('export-a@example.com');
    await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'In Range', dueDate: '2026-06-15', lineItems: sampleLineItems() });
    await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Before Range', dueDate: '2026-01-01', lineItems: sampleLineItems() });
    await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'After Range', dueDate: '2026-12-31', lineItems: sampleLineItems() });

    const res = await request(app).get('/api/v1/orders/export?from=2026-06-01&to=2026-06-30').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('Customer,Due Date,Status,Paid Late,Total,Paid,Due,Created At');
    expect(lines).toHaveLength(2); // header + exactly the one in-range order
    expect(lines[1]).toContain('In Range');
    expect(lines[1]).toContain('2026-06-15');
  });

  it('includes the boundary dates themselves (inclusive range)', async () => {
    const cookie = await signupAndLogin('export-b@example.com');
    await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'On Start', dueDate: '2026-06-01', lineItems: sampleLineItems() });
    await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'On End', dueDate: '2026-06-30', lineItems: sampleLineItems() });

    const res = await request(app).get('/api/v1/orders/export?from=2026-06-01&to=2026-06-30').set('Cookie', cookie);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + both boundary orders
  });

  it("only exports the caller's own orders", async () => {
    const owner = await signupAndLogin('export-owner@example.com');
    const other = await signupAndLogin('export-other@example.com');
    await request(app).post('/api/v1/orders').set('Cookie', owner).send({ customer: 'Mine', dueDate: '2026-06-15', lineItems: sampleLineItems() });
    await request(app).post('/api/v1/orders').set('Cookie', other).send({ customer: 'Theirs', dueDate: '2026-06-15', lineItems: sampleLineItems() });

    const res = await request(app).get('/api/v1/orders/export?from=2026-01-01&to=2026-12-31').set('Cookie', owner);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Mine');
  });

  it('reflects derived status and paidLate, not stored fields', async () => {
    const cookie = await signupAndLogin('export-status@example.com');
    const created = await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Settled Late', dueDate: '2026-06-01', lineItems: sampleLineItems() });
    await request(app)
      .post(`/api/v1/orders/${created.body._id}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 100_000, paidOn: '2026-06-10', idempotencyKey: 'export-late-1' });

    const res = await request(app).get('/api/v1/orders/export?from=2026-01-01&to=2026-12-31').set('Cookie', cookie);
    const [, row] = res.text.trim().split('\r\n');
    expect(row).toContain('Paid');
    expect(row).toContain('Yes'); // Paid Late column
  });

  it('rejects a malformed date', async () => {
    const cookie = await signupAndLogin('export-c@example.com');
    const res = await request(app).get('/api/v1/orders/export?from=not-a-date&to=2026-12-31').set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a range where "from" is after "to"', async () => {
    const cookie = await signupAndLogin('export-d@example.com');
    const res = await request(app).get('/api/v1/orders/export?from=2026-12-31&to=2026-01-01').set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires both from and to', async () => {
    const cookie = await signupAndLogin('export-e@example.com');
    const res = await request(app).get('/api/v1/orders/export?from=2026-01-01').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/orders/:id', () => {
  it("returns 404 for another user's order — never a distinguishable 403", async () => {
    const owner = await signupAndLogin('j@example.com');
    const intruder = await signupAndLogin('k@example.com');

    const created = await request(app).post('/api/v1/orders').set('Cookie', owner).send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    const res = await request(app).get(`/api/v1/orders/${created.body._id}`).set('Cookie', intruder);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a well-formed but nonexistent id', async () => {
    const cookie = await signupAndLogin('l@example.com');
    const res = await request(app).get('/api/v1/orders/000000000000000000000000').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/orders/:id', () => {
  it('updates an unpaid order freely', async () => {
    const cookie = await signupAndLogin('m@example.com');
    const created = await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Old', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const res = await request(app)
      .patch(`/api/v1/orders/${created.body._id}`)
      .set('Cookie', cookie)
      .send({ customer: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.customer).toBe('New Name');
  });

  it('returns 409 ORDER_LOCKED when editing line items after a payment', async () => {
    const cookie = await signupAndLogin('n@example.com');
    const created = await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    // The payment endpoint doesn't exist yet — simulate the locked state directly.
    await Order.updateOne({ _id: created.body._id }, { $set: { amountPaidCents: 40_000 } });

    const res = await request(app)
      .patch(`/api/v1/orders/${created.body._id}`)
      .set('Cookie', cookie)
      .send({ lineItems: [{ description: 'x', quantity: 1, unitPriceCents: 100 }] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_LOCKED');
  });
});

describe('DELETE /api/v1/orders/:id', () => {
  it('deletes an unpaid order', async () => {
    const cookie = await signupAndLogin('o@example.com');
    const created = await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const res = await request(app).delete(`/api/v1/orders/${created.body._id}`).set('Cookie', cookie);
    expect(res.status).toBe(204);

    const getRes = await request(app).get(`/api/v1/orders/${created.body._id}`).set('Cookie', cookie);
    expect(getRes.status).toBe(404);
  });

  it('returns 409 ORDER_LOCKED when payments have been recorded', async () => {
    const cookie = await signupAndLogin('p@example.com');
    const created = await request(app).post('/api/v1/orders').set('Cookie', cookie).send({ customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await Order.updateOne({ _id: created.body._id }, { $set: { amountPaidCents: 40_000 } });

    const res = await request(app).delete(`/api/v1/orders/${created.body._id}`).set('Cookie', cookie);
    expect(res.status).toBe(409);
  });
});
