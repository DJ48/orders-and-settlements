import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { seed, DEMO_EMAIL, DEMO_PASSWORD } from '../../src/scripts/seed';
import { User } from '../../src/models/User';
import { Order } from '../../src/models/Order';
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

  it('is safe to run twice — skips instead of erroring on a duplicate email', async () => {
    await seed();
    await expect(seed()).resolves.toBeUndefined();

    expect(await User.countDocuments({ email: DEMO_EMAIL })).toBe(1);
    expect(await Order.countDocuments({})).toBe(5); // not doubled
  });
});
