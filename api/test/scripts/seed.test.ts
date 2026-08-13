import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { seed, SEED_ACCOUNTS, DEMO_ACCOUNT, VIDEO_ACCOUNT } from '../../src/scripts/seed';
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
  it('creates every account with credentials that actually log in', async () => {
    await seed();

    for (const account of SEED_ACCOUNTS) {
      const { user } = await login(account.email, account.password);
      expect(user.email).toBe(account.email);
    }
  });

  it.each(SEED_ACCOUNTS)(
    'gives $email one order in each status',
    async (account) => {
      await seed();

      const { user } = await login(account.email, account.password);
      // listOrders returns raw stored documents (status/paidLate are response-layer derived
      // fields, not stored) — shape them the same way the real API would before asserting.
      const { orders: raw, total } = await listOrders(user._id, { pageSize: 100 });
      const orders = raw.map(toOrderSummaryResponse);

      expect(total).toBe(5);
      expect(orders.filter((o) => o.status === 'pending')).toHaveLength(1);
      expect(orders.filter((o) => o.status === 'overdue')).toHaveLength(1);
      expect(orders.filter((o) => o.status === 'partially_paid')).toHaveLength(1);

      const paidOrders = orders.filter((o) => o.status === 'paid');
      expect(paidOrders).toHaveLength(2);
      expect(paidOrders.some((o) => o.paidLate)).toBe(true); // settled after its due date
      expect(paidOrders.some((o) => !o.paidLate)).toBe(true); // settled on time
    },
  );

  it('keeps the two accounts fully separate', async () => {
    await seed();

    const { user: demo } = await login(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);
    const { user: video } = await login(VIDEO_ACCOUNT.email, VIDEO_ACCOUNT.password);
    expect(String(demo._id)).not.toBe(String(video._id));

    const demoNames = await Order.find({ userId: demo._id }).distinct('customer');
    const videoNames = await Order.find({ userId: video._id }).distinct('customer');

    // Distinct customer names are what make it obvious which account is on screen mid-recording.
    expect(demoNames.filter((n) => videoNames.includes(n))).toEqual([]);
  });

  it.each(SEED_ACCOUNTS)('gives every $email order a timeline worth reading', async (account) => {
    await seed();

    const { user } = await login(account.email, account.password);
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

  it("spreads each order's entries over time rather than stamping them all at once", async () => {
    await seed();

    const { user } = await login(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);
    const order = await Order.findOne({ userId: user._id, customer: DEMO_ACCOUNT.customers.partial });
    const entries = await AuditLog.find({ orderId: order!._id }).sort({ at: 1 });

    const stamps = entries.map((e) => new Date(e.at).getTime());
    expect(new Set(stamps).size).toBe(stamps.length); // no two share a timestamp
    expect(stamps[stamps.length - 1]! - stamps[0]!).toBeGreaterThan(60 * 60 * 1000); // spans > 1h
  });

  it('records the rename on the paid-late order, not just its final name', async () => {
    await seed();

    const { user } = await login(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password);
    const order = await Order.findOne({ userId: user._id, customer: DEMO_ACCOUNT.customers.late });
    const edit = await AuditLog.findOne({ orderId: order!._id, action: 'order.updated' });

    expect((edit!.delta as { changes: { customer: { from: string; to: string } } }).changes.customer).toEqual({
      from: DEMO_ACCOUNT.customers.lateBefore,
      to: DEMO_ACCOUNT.customers.late,
    });
  });

  it('is safe to run twice — skips instead of erroring on a duplicate email', async () => {
    await seed();
    await expect(seed()).resolves.toBeUndefined();

    expect(await User.countDocuments({})).toBe(SEED_ACCOUNTS.length);
    expect(await Order.countDocuments({})).toBe(SEED_ACCOUNTS.length * 5); // not doubled
  });
});
