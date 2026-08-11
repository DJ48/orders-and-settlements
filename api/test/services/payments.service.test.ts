import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { bootstrap } from '../../src/scripts/bootstrap';
import { User } from '../../src/models/User';
import { Order } from '../../src/models/Order';
import { AuditLog } from '../../src/models/AuditLog';
import { createOrder } from '../../src/services/orders.service';
import { recordPayment } from '../../src/services/payments.service';
import { NotFoundError, ValidationError, OverpaymentError } from '../../src/utils/errors';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(replSet.getUri('payments_service_test'));
  await bootstrap(replSet.getUri('payments_service_test'), () => {});
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

async function makeOrder(userId: import('mongoose').Types.ObjectId, totalDecimalCents = 100_000) {
  return createOrder(userId, {
    customer: 'Acme Corp',
    dueDate: '2026-08-20',
    lineItems: [{ description: 'Widget', quantity: 2, unitPriceCents: totalDecimalCents / 2 }],
  });
}

describe("the brief's own scenario, end to end", () => {
  it('$1,000 order → $400 partial → $600 settles it → $1 more is rejected', async () => {
    const user = await makeUser('a@example.com');
    const order = await makeOrder(user._id); // 2 × $500 = $1,000, due in 7 days per the brief

    const afterFirst = await recordPayment(user._id, order._id.toString(), {
      amountCents: 40_000,
      paidOn: '2026-08-01',
      idempotencyKey: 'k1',
    });
    expect(afterFirst.amountPaidCents).toBe(40_000);
    expect(afterFirst.settlementState).toBe('partial'); // partially_paid, $600 due

    const afterSecond = await recordPayment(user._id, order._id.toString(), {
      amountCents: 60_000,
      paidOn: '2026-08-02',
      idempotencyKey: 'k2',
    });
    expect(afterSecond.amountPaidCents).toBe(100_000);
    expect(afterSecond.settlementState).toBe('settled'); // paid, $0 due

    // The brief's own named case: reject the extra $1 with a clear, actionable error.
    let error: unknown;
    try {
      await recordPayment(user._id, order._id.toString(), {
        amountCents: 100,
        paidOn: '2026-08-03',
        idempotencyKey: 'k3',
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(OverpaymentError);
    expect((error as OverpaymentError).details).toEqual({ attemptedCents: 100, maxAllowedCents: 0 });
    expect((error as OverpaymentError).message).toContain('$1.00');
    expect((error as OverpaymentError).message).toContain('$0.00');
  });
});

describe('concurrency — the actual guard, not a mock of it', () => {
  it('lets exactly one of two simultaneous payments commit', async () => {
    const user = await makeUser('b@example.com');
    const order = await makeOrder(user._id);
    await recordPayment(user._id, order._id.toString(), { amountCents: 40_000, paidOn: '2026-08-01', idempotencyKey: 'seed' });

    const results = await Promise.allSettled([
      recordPayment(user._id, order._id.toString(), { amountCents: 60_000, paidOn: '2026-08-02', idempotencyKey: 'race-a' }),
      recordPayment(user._id, order._id.toString(), { amountCents: 60_000, paidOn: '2026-08-02', idempotencyKey: 'race-b' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OverpaymentError);

    const final = await Order.findById(order._id);
    expect(final?.amountPaidCents).toBe(100_000); // never exceeds the total, never under-counts
    expect(final?.payments).toHaveLength(2);
  });

  it('holds under heavier parallelism: 20 × $100 on a $1,000 order settles at exactly 10', async () => {
    const user = await makeUser('c@example.com');
    const order = await makeOrder(user._id);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        recordPayment(user._id, order._id.toString(), {
          amountCents: 10_000,
          paidOn: '2026-08-01',
          idempotencyKey: `bulk-${i}`,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);

    const final = await Order.findById(order._id);
    expect(final?.amountPaidCents).toBe(100_000);
    expect(final?.settlementState).toBe('settled');
  });
});

describe('idempotency', () => {
  it('a replayed key returns the existing state rather than charging twice', async () => {
    const user = await makeUser('d@example.com');
    const order = await makeOrder(user._id);

    const first = await recordPayment(user._id, order._id.toString(), { amountCents: 25_000, paidOn: '2026-08-01', idempotencyKey: 'same' });
    const replay = await recordPayment(user._id, order._id.toString(), { amountCents: 25_000, paidOn: '2026-08-01', idempotencyKey: 'same' });

    expect(replay.amountPaidCents).toBe(25_000); // unchanged — not charged a second time
    expect(replay._id.toString()).toBe(first._id.toString());
    expect(replay.payments).toHaveLength(1);
  });

  it('does not write a duplicate payment.recorded audit entry for a replay', async () => {
    const user = await makeUser('e@example.com');
    const order = await makeOrder(user._id);

    await recordPayment(user._id, order._id.toString(), { amountCents: 25_000, paidOn: '2026-08-01', idempotencyKey: 'same' });
    await recordPayment(user._id, order._id.toString(), { amountCents: 25_000, paidOn: '2026-08-01', idempotencyKey: 'same' });

    expect(await AuditLog.countDocuments({ action: 'payment.recorded', orderId: order._id })).toBe(1);
  });
});

describe('ownership and existence', () => {
  it("cannot pay another user's order — NotFoundError, not a distinguishable 403", async () => {
    const owner = await makeUser('f@example.com');
    const intruder = await makeUser('g@example.com');
    const order = await makeOrder(owner._id);

    await expect(
      recordPayment(intruder._id, order._id.toString(), { amountCents: 1000, paidOn: '2026-08-01', idempotencyKey: 'x' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects a nonexistent order id', async () => {
    const user = await makeUser('h@example.com');
    await expect(
      recordPayment(user._id, '000000000000000000000000', { amountCents: 1000, paidOn: '2026-08-01', idempotencyKey: 'x' }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('validation', () => {
  it('rejects a future-dated payment', async () => {
    const user = await makeUser('i@example.com');
    const order = await makeOrder(user._id);
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await expect(
      recordPayment(user._id, order._id.toString(), { amountCents: 1000, paidOn: farFuture, idempotencyKey: 'x' }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('lastPaymentOn — $max, not an unconditional overwrite', () => {
  it('a backdated correction inserted after a later payment does not move lastPaymentOn backward', async () => {
    const user = await makeUser('j@example.com');
    const order = await makeOrder(user._id);

    await recordPayment(user._id, order._id.toString(), { amountCents: 40_000, paidOn: '2026-08-10', idempotencyKey: 'k1' });
    // Second payment is entered with an EARLIER business date (a backdated correction) —
    // lastPaymentOn must stay at the later real date, or a genuinely late settlement would
    // wrongly read as on time.
    const after = await recordPayment(user._id, order._id.toString(), { amountCents: 60_000, paidOn: '2026-08-05', idempotencyKey: 'k2' });

    expect(after.lastPaymentOn?.toISOString().slice(0, 10)).toBe('2026-08-10');
  });
});

describe('settlementState transitions', () => {
  it('unpaid → partial → settled, matching the money actually recorded', async () => {
    const user = await makeUser('k@example.com');
    const order = await makeOrder(user._id);
    expect(order.settlementState).toBe('unpaid');

    const partial = await recordPayment(user._id, order._id.toString(), { amountCents: 1, paidOn: '2026-08-01', idempotencyKey: 'k1' });
    expect(partial.settlementState).toBe('partial');

    const settled = await recordPayment(user._id, order._id.toString(), { amountCents: 99_999, paidOn: '2026-08-01', idempotencyKey: 'k2' });
    expect(settled.settlementState).toBe('settled');
  });
});
