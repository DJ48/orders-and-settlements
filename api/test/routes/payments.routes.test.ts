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
  await connectDatabase(replSet.getUri('payments_routes_test'));
  await bootstrap(replSet.getUri('payments_routes_test'), () => {});
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

async function createSampleOrder(cookie: string[]) {
  const res = await request(app)
    .post('/api/v1/orders')
    .set('Cookie', cookie)
    .send({ customer: 'Acme Corp', dueDate: '2026-08-20', lineItems: [{ description: 'Widget', quantity: 2, unitPriceCents: 50_000 }] });
  return res.body._id as string;
}

describe('POST /api/v1/orders/:id/payments', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/orders/000000000000000000000000/payments').send({
      amountCents: 100,
      paidOn: '2026-08-01',
      idempotencyKey: 'x',
    });
    expect(res.status).toBe(401);
  });

  it("runs the brief's scenario over real HTTP: $400 partial, $600 settles, $1 more rejected", async () => {
    const cookie = await signupAndLogin('a@example.com');
    const orderId = await createSampleOrder(cookie);

    const first = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 40_000, paidOn: '2026-08-01', idempotencyKey: 'k1' });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('partially_paid');
    expect(first.body.amountDueCents).toBe(60_000);

    const second = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 60_000, paidOn: '2026-08-02', idempotencyKey: 'k2' });
    expect(second.status).toBe(201);
    expect(second.body.status).toBe('paid');
    expect(second.body.amountDueCents).toBe(0);

    const third = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 100, paidOn: '2026-08-03', idempotencyKey: 'k3' });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('OVERPAYMENT');
    // The actionable hint the brief explicitly asks for.
    expect(third.body.error.details.maxAllowedCents).toBe(0);
  });

  it('the payment appears in the history on the very next GET', async () => {
    const cookie = await signupAndLogin('b@example.com');
    const orderId = await createSampleOrder(cookie);

    await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 40_000, paidOn: '2026-08-01', note: 'Deposit', idempotencyKey: 'k1' });

    const detail = await request(app).get(`/api/v1/orders/${orderId}`).set('Cookie', cookie);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.payments[0]).toMatchObject({ amountCents: 40_000, note: 'Deposit' });
  });

  it('locks line-item editing the moment a payment lands, but customer/dueDate stay editable while not yet overdue', async () => {
    const cookie = await signupAndLogin('c@example.com');
    const orderId = await createSampleOrder(cookie); // due 2026-08-20, well in the future

    await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 1, paidOn: '2026-08-01', idempotencyKey: 'k1' });

    const lineItemEdit = await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ lineItems: [{ description: 'x', quantity: 1, unitPriceCents: 100 }] });
    expect(lineItemEdit.status).toBe(409);
    expect(lineItemEdit.body.error.code).toBe('ORDER_LOCKED');

    const metadataEdit = await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ customer: 'Renamed' });
    expect(metadataEdit.status).toBe(200);
  });

  it('rejects a malformed amount with the documented validation envelope', async () => {
    const cookie = await signupAndLogin('d@example.com');
    const orderId = await createSampleOrder(cookie);

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', cookie)
      .send({ amountCents: 0, paidOn: '2026-08-01', idempotencyKey: 'k1' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("cannot pay another user's order", async () => {
    const owner = await signupAndLogin('e@example.com');
    const intruder = await signupAndLogin('f@example.com');
    const orderId = await createSampleOrder(owner);

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Cookie', intruder)
      .send({ amountCents: 100, paidOn: '2026-08-01', idempotencyKey: 'k1' });

    expect(res.status).toBe(404);
  });

  it('replaying the same idempotency key returns 201 with the unchanged state, not a duplicate charge', async () => {
    const cookie = await signupAndLogin('g@example.com');
    const orderId = await createSampleOrder(cookie);
    const payload = { amountCents: 40_000, paidOn: '2026-08-01', idempotencyKey: 'same-key' };

    const first = await request(app).post(`/api/v1/orders/${orderId}/payments`).set('Cookie', cookie).send(payload);
    const replay = await request(app).post(`/api/v1/orders/${orderId}/payments`).set('Cookie', cookie).send(payload);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.amountPaidCents).toBe(40_000);
  });
});
