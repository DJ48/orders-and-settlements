import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { seed, resetDemo, DEMO_EMAIL, DEMO_PASSWORD } from '../../src/scripts/seed';
import { User } from '../../src/models/User';
import { Order } from '../../src/models/Order';
import { AuditLog } from '../../src/models/AuditLog';
import { login } from '../../src/services/auth.service';
import { listOrders } from '../../src/services/orders.service';
import { toOrderSummaryResponse } from '../../src/controllers/orderResponse';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('seed_script_test'));
  await bootstrap(replSet.getUri('seed_script_test'), () => {});
}, 180_000);

afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Order.deleteMany({});
  await AuditLog.deleteMany({});
});

describe('seed', () => {
  it('creates a demo user that can actually log in with the documented credentials', async () => {
    await seed();

    const { user } = await login(DEMO_EMAIL, DEMO_PASSWORD);
    expect(user.email).toBe(DEMO_EMAIL);
  });

  it('creates orders covering pending, overdue, partially paid, paid, and paid-late', async () => {
    await seed();

    const { user } = await login(DEMO_EMAIL, DEMO_PASSWORD);
    // listOrders returns raw stored documents (status/paidLate are response-layer derived
    // fields, not stored) — shape them the same way the real API would before asserting on them.
    const { orders: raw, total } = await listOrders(user._id, { pageSize: 100 });
    const orders = raw.map(toOrderSummaryResponse);

    expect(total).toBe(5);
    expect(orders.filter((o) => o.status === 'pending')).toHaveLength(1);
    expect(orders.filter((o) => o.status === 'overdue')).toHaveLength(1);
    expect(orders.filter((o) => o.status === 'partially_paid')).toHaveLength(1);

    const paidOrders = orders.filter((o) => o.status === 'paid');
    expect(paidOrders).toHaveLength(2);
    expect(paidOrders.some((o) => o.paidLate)).toBe(true); // Hooli Inc — paid after its due date
    expect(paidOrders.some((o) => !o.paidLate)).toBe(true); // Acme Manufacturing — paid on time
  });

  it('gives every order a timeline, including an edit and a refused over-payment', async () => {
    await seed();

    const { user } = await login(DEMO_EMAIL, DEMO_PASSWORD);
    const orders = await Order.find({ userId: user._id });

    for (const order of orders) {
      const count = await AuditLog.countDocuments({ orderId: order._id });
      expect(count, `${order.customer} has no trail`).toBeGreaterThan(1);
    }

    const actions = await AuditLog.find({ userId: user._id }).distinct('action');
    expect(actions).toContain('order.created');
    expect(actions).toContain('order.updated');
    expect(actions).toContain('payment.recorded');
    // The refusal is the one a reviewer most wants to see, and the easiest to seed away by
    // accident — the seed swallows OverpaymentError, so nothing else would catch its absence.
    expect(actions).toContain('payment.rejected');
  });

  it('spreads each order\'s entries over time rather than stamping them all at once', async () => {
    await seed();

    const { user } = await login(DEMO_EMAIL, DEMO_PASSWORD);
    const order = await Order.findOne({ userId: user._id, customer: 'Initech LLC' });
    const entries = await AuditLog.find({ orderId: order!._id }).sort({ at: 1 });

    const stamps = entries.map((e) => new Date(e.at).getTime());
    expect(new Set(stamps).size).toBe(stamps.length); // no two share a timestamp
    expect(stamps[stamps.length - 1]! - stamps[0]!).toBeGreaterThan(60 * 60 * 1000); // spans > 1h
  });

  it('resetDemo removes the user and everything belonging to it', async () => {
    await seed();
    const { user } = await login(DEMO_EMAIL, DEMO_PASSWORD);

    await resetDemo();

    expect(await User.countDocuments({ email: DEMO_EMAIL })).toBe(0);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    expect(await AuditLog.countDocuments({ userId: user._id })).toBe(0);
  });

  it('reset then seed rebuilds a complete demo rather than doubling it', async () => {
    await seed();
    await resetDemo();
    await seed();

    const { user } = await login(DEMO_EMAIL, DEMO_PASSWORD);
    expect(await Order.countDocuments({ userId: user._id })).toBe(5);
  });

  it('is safe to run twice — skips instead of erroring on a duplicate email', async () => {
    await seed();
    await expect(seed()).resolves.toBeUndefined();

    expect(await User.countDocuments({ email: DEMO_EMAIL })).toBe(1);
    expect(await Order.countDocuments({})).toBe(5); // not doubled
  });
});
