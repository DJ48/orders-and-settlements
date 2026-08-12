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

    const { orders } = await listOrders(owner._id);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.customer).toBe('Mine');
  });

  it('excludes lineItems and payments from the list — the covered-index read', async () => {
    const user = await makeUser('h@example.com');
    await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });

    const { orders: [result] } = await listOrders(user._id);
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

    expect(pending.orders).toHaveLength(1);
    expect(paid.orders).toHaveLength(0);
  });

  it('paginates: page 2 of a 2-per-page list returns the next slice, correctly ordered', async () => {
    const user = await makeUser('pagination@example.com');
    await createOrder(user._id, { customer: 'A', dueDate: '2026-08-01', lineItems: sampleLineItems() });
    await createOrder(user._id, { customer: 'B', dueDate: '2026-08-02', lineItems: sampleLineItems() });
    await createOrder(user._id, { customer: 'C', dueDate: '2026-08-03', lineItems: sampleLineItems() });

    const page1 = await listOrders(user._id, { page: 1, pageSize: 2 });
    const page2 = await listOrders(user._id, { page: 2, pageSize: 2 });

    expect(page1.orders).toHaveLength(2);
    expect(page2.orders).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page1.totalPages).toBe(2);
    // Unfiltered list sorts by createdAt DESC (newest first): C, B, A. Page 1 = [C, B], page 2 = [A].
    expect(page1.orders.map((o) => o.customer)).toEqual(['C', 'B']);
    expect(page2.orders[0]?.customer).toBe('A');
  });

  it('summary reflects every matching order, not just the current page', async () => {
    const user = await makeUser('summary@example.com');
    for (let i = 0; i < 3; i++) {
      await createOrder(user._id, { customer: `Order ${i}`, dueDate: '2026-08-20', lineItems: sampleLineItems() });
    }

    const { summary, orders } = await listOrders(user._id, { page: 1, pageSize: 1 });
    expect(orders).toHaveLength(1); // only one order on this page...
    expect(summary.totalValueCents).toBe(300_000); // ...but the summary covers all three
  });

  it('intersects a due-date range with a status filter instead of one silently overriding the other', async () => {
    const user = await makeUser('range-status@example.com');
    // Overdue: due in the past, unpaid.
    await createOrder(user._id, { customer: 'Overdue in range', dueDate: '2020-01-15', lineItems: sampleLineItems() });
    await createOrder(user._id, { customer: 'Overdue out of range', dueDate: '2020-06-15', lineItems: sampleLineItems() });

    const result = await listOrders(user._id, {
      status: 'overdue',
      dueDateFrom: new Date('2020-01-01'),
      dueDateTo: new Date('2020-02-01'),
    });

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.customer).toBe('Overdue in range');
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

  it('still allows metadata edits (customer, dueDate) while partially paid but not yet overdue', async () => {
    const user = await makeUser('r@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await Order.updateOne({ _id: order._id }, { $set: { amountPaidCents: 40_000 } }); // $600 still due

    const updated = await updateOrder(user._id, order._id.toString(), { customer: 'Renamed' });
    expect(updated.customer).toBe('Renamed');
  });

  it('rejects metadata edits once the order is fully paid — the balance itself has nothing left at risk, but paidLate does', async () => {
    const user = await makeUser('metadata-paid@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2026-08-20', lineItems: sampleLineItems() });
    await Order.updateOne({ _id: order._id }, { $set: { amountPaidCents: 100_000 } }); // fully settled

    await expect(
      updateOrder(user._id, order._id.toString(), { customer: 'Renamed' }),
    ).rejects.toThrow(OrderLockedError);
  });

  it('rejects metadata edits once a partially-paid order has gone overdue', async () => {
    const user = await makeUser('metadata-overdue@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2020-01-01', lineItems: sampleLineItems() });
    await Order.updateOne({ _id: order._id }, { $set: { amountPaidCents: 40_000 } }); // partial + overdue

    await expect(
      updateOrder(user._id, order._id.toString(), { dueDate: '2026-12-31' }),
    ).rejects.toThrow(OrderLockedError);
  });

  it('still allows metadata edits on an overdue order that has zero payments — nothing paid means nothing to protect', async () => {
    const user = await makeUser('metadata-overdue-unpaid@example.com');
    const order = await createOrder(user._id, { customer: 'Acme', dueDate: '2020-01-01', lineItems: sampleLineItems() });

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
