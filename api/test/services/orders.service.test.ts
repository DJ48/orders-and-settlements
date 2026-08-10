import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { User } from '../../src/models/User';
import { Order } from '../../src/models/Order';
import { AuditLog } from '../../src/models/AuditLog';
import {
  listOrders,
  createOrder,
  getOrder,
  updateOrder,
  deleteOrder,
} from '../../src/services/orders.service';
import { NotFoundError, ValidationError, OrderLockedError, ConflictError } from '../../src/utils/errors';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('orders_service_test'));
  await bootstrap(replSet.getUri('orders_service_test'), () => {});
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

async function makeUser(email: string) {
  return User.create({ email, passwordHash: 'not-a-real-hash' });
}

const sampleLineItems = () => [{ description: 'Widget', quantity: 2, unitPriceCents: 50_000 }];

describe('createOrder', () => {
  it("computes totals server-side using the brief's example: 2 × $500 = $1,000", async () => {
    const user = await makeUser('a@example.com');
    const order = await createOrder(user._id, {
      customer: 'Acme Corp',
      dueDate: '2026-08-20',
      lineItems: sampleLineItems(),
    });

    expect(order.totalCents).toBe(100_000);
    expect(order.subtotalCents).toBe(100_000);
    expect(order.amountPaidCents).toBe(0);
    expect(order.settlementState).toBe('unpaid');
  });

  it('normalises the due date to UTC midnight regardless of input time', async () => {
    const user = await makeUser('b@example.com');
    const order = await createOrder(user._id, {
      customer: 'Acme',
      dueDate: '2026-08-20',
      lineItems: sampleLineItems(),
    });

    expect(order.dueDate.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('rejects invalid line items with a ValidationError, not a raw MoneyError', async () => {
    const user = await makeUser('c@example.com');
    await expect(
      createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: [] }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a zero-total order', async () => {
    const user = await makeUser('d@example.com');
    await expect(
      createOrder(user._id, {
        customer: 'Acme',
        dueDate: '2026-08-20',
        lineItems: [{ description: 'Free', quantity: 1, unitPriceCents: 0 }],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('writes an order.created audit entry', async () => {
    const user = await makeUser('e@example.com');
    const order = await createOrder(user._id, {
      customer: 'Acme',
      dueDate: '2026-08-20',
      lineItems: sampleLineItems(),
    });

    const entry = await AuditLog.findOne({ action: 'order.created', orderId: order._id });
    expect(entry).not.toBeNull();
    expect(entry?.snapshot?.totalCents).toBe(100_000);
  });
});

describe('listOrders', () => {
  it("only returns the calling user's own orders", async () => {
    const owner = await makeUser('f@example.com');
    const other = await makeUser('g@example.com');
    await createOrder(owner._id, { customer: 'Mine', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await createOrder(other._id, { customer: 'Theirs', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const results = await listOrders(owner._id);
    expect(results).toHaveLength(1);
    expect(results[0]?.customer).toBe('Mine');
  });

  it('excludes lineItems and payments from the list — the covered-index read', async () => {
    const user = await makeUser('h@example.com');
    await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const [result] = await listOrders(user._id);
    expect(result).not.toHaveProperty('lineItems');
    expect(result).not.toHaveProperty('payments');
  });

  it('the unfiltered list is an index-covered scan, not a collection scan', async () => {
    const user = await makeUser('explain@example.com');
    await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const explanation: any = await Order.find({ userId: user._id, deletedAt: null })
      .sort({ createdAt: -1 })
      .explain('executionStats');

    const stage = JSON.stringify(explanation.queryPlanner.winningPlan);
    expect(stage).toContain('IXSCAN');
    expect(stage).not.toContain('COLLSCAN');
  });

  it('filters by status using the derived value, not a stored field', async () => {
    const user = await makeUser('i@example.com');
    await createOrder(user._id, { customer: 'Unpaid one', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const pending = await listOrders(user._id, { status: 'pending' });
    const paid = await listOrders(user._id, { status: 'paid' });

    expect(pending).toHaveLength(1);
    expect(paid).toHaveLength(0);
  });
});

describe('getOrder', () => {
  it('returns the order for its owner', async () => {
    const user = await makeUser('j@example.com');
    const created = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const fetched = await getOrder(user._id, created._id.toString());
    expect(fetched._id.toString()).toBe(created._id.toString());
  });

  it("returns NotFoundError for another user's order — never a distinguishable 403", async () => {
    const owner = await makeUser('k@example.com');
    const intruder = await makeUser('l@example.com');
    const order = await createOrder(owner._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    await expect(getOrder(intruder._id, order._id.toString())).rejects.toThrow(NotFoundError);
  });

  it('returns NotFoundError for a malformed id rather than a Mongoose CastError', async () => {
    const user = await makeUser('m@example.com');
    await expect(getOrder(user._id, 'not-a-valid-object-id')).rejects.toThrow(NotFoundError);
  });

  it('returns NotFoundError for a soft-deleted order', async () => {
    const user = await makeUser('n@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await deleteOrder(user._id, order._id.toString());

    await expect(getOrder(user._id, order._id.toString())).rejects.toThrow(NotFoundError);
  });
});

describe('updateOrder', () => {
  it('updates customer and due date freely on an unpaid order', async () => {
    const user = await makeUser('o@example.com');
    const order = await createOrder(user._id, { customer: 'Old Name', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const updated = await updateOrder(user._id, order._id.toString(), {
      customer: 'New Name',
      dueDate: '2026-09-01',
    });

    expect(updated.customer).toBe('New Name');
    expect(updated.dueDate.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('recomputes totals when line items change on an unpaid order', async () => {
    const user = await makeUser('p@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const updated = await updateOrder(user._id, order._id.toString(), {
      lineItems: [{ description: 'New widget', quantity: 3, unitPriceCents: 1000 }],
    });

    expect(updated.totalCents).toBe(3000);
    expect(updated.lineItems).toHaveLength(1);
    expect(updated.lineItems[0]?.description).toBe('New widget');
  });

  it('rejects a line-item edit once a payment exists — the lock lives on the scalar', async () => {
    const user = await makeUser('q@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    // Simulate a payment having been recorded (the payment endpoint doesn't exist yet).
    await Order.updateOne({ _id: order._id }, { $set: { amountPaidCents: 40_000 } });

    await expect(
      updateOrder(user._id, order._id.toString(), {
        lineItems: [{ description: 'x', quantity: 1, unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(OrderLockedError);
  });

  it('still allows metadata edits (customer, dueDate) even once locked', async () => {
    const user = await makeUser('r@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await Order.updateOne({ _id: order._id }, { $set: { amountPaidCents: 40_000 } });

    const updated = await updateOrder(user._id, order._id.toString(), { customer: 'Renamed' });
    expect(updated.customer).toBe('Renamed');
  });

  it('raises ConflictError on a lost-update race between two concurrent edits', async () => {
    const user = await makeUser('s@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    // Two independently-fetched documents of the same order, simulating two requests that both
    // read before either wrote.
    const copyA = await Order.findById(order._id);
    const copyB = await Order.findById(order._id);
    copyA!.customer = 'From A';
    copyB!.customer = 'From B';

    await copyA!.save(); // succeeds, bumps __v
    await expect(copyB!.save()).rejects.toBeInstanceOf(mongoose.Error.VersionError);
  });

  it('does not bump orderModifiedAt or write to the DB when nothing actually changed', async () => {
    const user = await makeUser('t@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    const before = order.orderModifiedAt.getTime();

    const result = await updateOrder(user._id, order._id.toString(), {});
    expect(result.orderModifiedAt.getTime()).toBe(before);
  });
});

describe('deleteOrder', () => {
  it('soft-deletes an unpaid order', async () => {
    const user = await makeUser('u@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    await deleteOrder(user._id, order._id.toString());

    const stillInDb = await Order.findById(order._id);
    expect(stillInDb?.deletedAt).not.toBeNull();
  });

  it('blocks deletion once a payment has been recorded', async () => {
    const user = await makeUser('v@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await Order.updateOne({ _id: order._id }, { $set: { amountPaidCents: 40_000 } });

    await expect(deleteOrder(user._id, order._id.toString())).rejects.toThrow(OrderLockedError);
  });

  it("cannot delete another user's order", async () => {
    const owner = await makeUser('w@example.com');
    const intruder = await makeUser('x@example.com');
    const order = await createOrder(owner._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    await expect(deleteOrder(intruder._id, order._id.toString())).rejects.toThrow(NotFoundError);
  });
});
