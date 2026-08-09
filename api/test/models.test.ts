import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { bootstrap } from '../src/scripts/bootstrap';
import { User } from '../src/models/User';
import { Order } from '../src/models/Order';
import { computeTotals } from '../src/utils/totals';

/**
 * Proves the schema layer against a real MongoDB — indexes, the collection validator, and the
 * atomic payment guard expressed through Mongoose.
 *
 * A mocked database would happily "pass" tests for behaviour MongoDB does not actually have,
 * which is precisely the risk when the correctness story rests on server-side guarantees.
 */
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('orders_test'));
  await bootstrap(replSet.getUri('orders_test'), () => {});
}, 180_000);

afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

beforeEach(async () => {
  await Order.deleteMany({});
  await User.deleteMany({});
});

async function makeUser(email: string) {
  return User.create({ email, passwordHash: 'not-a-real-hash' });
}

async function makeOrder(userId: mongoose.Types.ObjectId, totalCents = 100_000) {
  const { lineItems, subtotalCents, totalCents: total } = computeTotals([
    { description: 'Widget', quantity: 2, unitPriceCents: totalCents / 2 },
  ]);

  return Order.create({
    userId,
    customer: 'Acme Corp',
    dueDate: new Date('2026-08-16T00:00:00Z'),
    lineItems,
    subtotalCents,
    totalCents: total,
  });
}

/** The production payment write — guard in the query predicate, not a read-then-check. */
async function recordPayment(
  orderId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  amountCents: number,
  idempotencyKey: string,
) {
  return Order.findOneAndUpdate(
    {
      _id: orderId,
      userId,
      deletedAt: null,
      'payments.idempotencyKey': { $ne: idempotencyKey },
      $expr: { $lte: [{ $add: ['$amountPaidCents', amountCents] }, '$totalCents'] },
    },
    [
      {
        $set: {
          amountPaidCents: { $add: ['$amountPaidCents', amountCents] },
          payments: {
            $concatArrays: [
              '$payments',
              [{ amountCents, paidOn: new Date(), idempotencyKey, createdAt: new Date() }],
            ],
          },
          lastPaymentOn: new Date(),
          settlementState: {
            $switch: {
              branches: [
                {
                  case: { $gte: [{ $add: ['$amountPaidCents', amountCents] }, '$totalCents'] },
                  then: 'settled',
                },
                { case: { $gt: [{ $add: ['$amountPaidCents', amountCents] }, 0] }, then: 'partial' },
              ],
              default: 'unpaid',
            },
          },
          updatedAt: new Date(),
        },
      },
    ],
    // A pipeline (not $inc/$push) so settlementState is recomputed from the NEW balance inside
    // the same atomic operation. Mongoose requires an explicit opt-in for pipeline updates.
    { returnDocument: 'after', updatePipeline: true },
  );
}

describe('bootstrap', () => {
  it('creates the orders collection with the over-payment validator', async () => {
    const db = mongoose.connection.db!;
    const [collection] = await db
      .listCollections({ name: 'orders' }, { nameOnly: false })
      .toArray();

    expect(collection?.options?.validator).toEqual({
      $expr: { $lte: ['$amountPaidCents', '$totalCents'] },
    });
    expect(collection?.options?.validationAction).toBe('error');
  });

  it('creates the dashboard index every status filter relies on', async () => {
    const names = (await Order.collection.indexes()).map((i) => i.name);
    expect(names).toContain('userId_1_deletedAt_1_settlementState_1_dueDate_1');
  });

  it('creates the unique partial index backing idempotency', async () => {
    const index = (await Order.collection.indexes()).find((i) => i.name?.includes('idempotencyKey'));
    expect(index?.unique).toBe(true);
    expect(index?.partialFilterExpression).toBeDefined();
  });
});

describe('Order schema', () => {
  it('rejects an order with no line items', async () => {
    const user = await makeUser('a@example.com');
    await expect(
      Order.create({
        userId: user._id,
        customer: 'Acme',
        dueDate: new Date(),
        lineItems: [],
        subtotalCents: 100,
        totalCents: 100,
      }),
    ).rejects.toThrow();
  });

  it('rejects fractional cents', async () => {
    const user = await makeUser('b@example.com');
    await expect(
      Order.create({
        userId: user._id,
        customer: 'Acme',
        dueDate: new Date(),
        lineItems: [{ description: 'W', quantity: 1, unitPriceCents: 10.5, lineTotalCents: 10.5 }],
        subtotalCents: 10.5,
        totalCents: 10.5,
      }),
    ).rejects.toThrow();
  });

  it('never exposes passwordHash unless explicitly selected', async () => {
    await makeUser('c@example.com');

    const found = await User.findOne({ email: 'c@example.com' });
    expect(found?.passwordHash).toBeUndefined();

    const explicit = await User.findOne({ email: 'c@example.com' }).select('+passwordHash');
    expect(explicit?.passwordHash).toBe('not-a-real-hash');
  });
});

describe('atomic payment guard', () => {
  it("runs the brief's scenario end to end", async () => {
    const user = await makeUser('d@example.com');
    const order = await makeOrder(user._id);

    const first = await recordPayment(order._id, user._id, 40_000, 'k1');
    expect(first?.amountPaidCents).toBe(40_000);
    expect(first?.settlementState).toBe('partial');

    const second = await recordPayment(order._id, user._id, 60_000, 'k2');
    expect(second?.amountPaidCents).toBe(100_000);
    expect(second?.settlementState).toBe('settled');

    // The $1 over-payment the brief asks you to reject
    expect(await recordPayment(order._id, user._id, 100, 'k3')).toBeNull();
  });

  it('lets exactly one of two concurrent payments commit', async () => {
    const user = await makeUser('e@example.com');
    const order = await makeOrder(user._id);
    await recordPayment(order._id, user._id, 40_000, 'seed');

    const results = await Promise.all([
      recordPayment(order._id, user._id, 60_000, 'race-a'),
      recordPayment(order._id, user._id, 60_000, 'race-b'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const final = await Order.findById(order._id);
    expect(final?.amountPaidCents).toBe(100_000);
    expect(final?.payments).toHaveLength(2);
  });

  it('holds under heavy parallelism', async () => {
    const user = await makeUser('f@example.com');
    const order = await makeOrder(user._id);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => recordPayment(order._id, user._id, 10_000, `bulk-${i}`)),
    );

    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await Order.findById(order._id))?.amountPaidCents).toBe(100_000);
  });

  it('refuses a replayed idempotency key', async () => {
    const user = await makeUser('g@example.com');
    const order = await makeOrder(user._id);

    expect(await recordPayment(order._id, user._id, 25_000, 'same')).not.toBeNull();
    expect(await recordPayment(order._id, user._id, 25_000, 'same')).toBeNull();
    expect((await Order.findById(order._id))?.amountPaidCents).toBe(25_000);
  });

  it('scopes by userId, so another user cannot pay your order', async () => {
    const owner = await makeUser('h@example.com');
    const other = await makeUser('i@example.com');
    const order = await makeOrder(owner._id);

    expect(await recordPayment(order._id, other._id, 10_000, 'intruder')).toBeNull();
  });
});

describe('collection validator (defence in depth)', () => {
  it('rejects an over-payment written directly, bypassing the guard', async () => {
    const user = await makeUser('j@example.com');
    const order = await makeOrder(user._id);

    await expect(
      Order.collection.updateOne({ _id: order._id }, { $set: { amountPaidCents: 999_900 } }),
    ).rejects.toMatchObject({ code: 121 });
  });
});
