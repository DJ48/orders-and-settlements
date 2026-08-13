import type { Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';
import { Order } from '../models/Order';
import { AuditLog } from '../models/AuditLog';
import { Session } from '../models/Session';
import { signup } from '../services/auth.service';
import { createOrder, updateOrder } from '../services/orders.service';
import { recordPayment } from '../services/payments.service';
import { OverpaymentError } from '../utils/errors';

/**
 * Reproducible local demo data — a demo user plus one order in each status.
 *
 *   npm run seed            create the demo user and its orders, skipping if it already exists
 *   npm run seed -- --reset delete the demo user's data first, then recreate it
 *
 * Every order is built through the real service functions, never raw writes, so the audit trail
 * these produce is the same trail the running app produces. Each order carries a different shape
 * of history — an edit, a refused payment, a settlement in two instalments — because the order
 * timeline is only worth looking at if there's something on it.
 *
 * Idempotent by inspection, not by design: without --reset an existing demo user skips the whole
 * seed rather than attempting to dedupe orders too. That's the right tradeoff for a local dev
 * convenience script, not a production migration.
 */

export const DEMO_EMAIL = 'demo@ordersandsettlements.com';
export const DEMO_PASSWORD = 'DemoPass123!';

function daysFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/**
 * Spreads one order's audit entries backwards from `startDaysAgo` so the timeline reads like a
 * history rather than five events in the same second.
 *
 * This rewrites `at` after the fact instead of letting recordAudit take a timestamp, deliberately:
 * an audit entry is stamped when it happens, and adding a caller-supplied `at` to the production
 * path so a dev script could backdate rows is exactly the door an audit trail should keep shut.
 * The seed reaches past the service layer because it is synthetic data, and says so here.
 */
async function backdateTrail(orderId: Types.ObjectId, startDaysAgo: number): Promise<void> {
  const entries = await AuditLog.find({ orderId }).sort({ at: 1 });
  const stepHours = 26;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    entry.at = hoursAgo(startDaysAgo * 24 - i * stepHours);
    await entry.save();
  }
}

/** Everything the demo user owns, so a re-seed starts from nothing. */
export async function resetDemo(): Promise<void> {
  const user = await User.findOne({ email: DEMO_EMAIL });
  if (!user) {
    console.log(`No demo user to reset.`);
    return;
  }

  const [orders, audit, sessions] = await Promise.all([
    Order.deleteMany({ userId: user._id }),
    AuditLog.deleteMany({ userId: user._id }),
    Session.deleteMany({ userId: user._id }),
  ]);
  await User.deleteOne({ _id: user._id });

  console.log(
    `Reset ${DEMO_EMAIL}: ${orders.deletedCount} orders, ${audit.deletedCount} audit entries, ${sessions.deletedCount} sessions.`,
  );
}

export async function seed(): Promise<void> {
  const existing = await User.findOne({ email: DEMO_EMAIL });
  if (existing) {
    console.log(`Demo user ${DEMO_EMAIL} already exists — skipping. Re-run with --reset to rebuild.`);
    return;
  }

  const user = await signup({ email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo Reviewer' });
  console.log(`Created demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

  // Pending — created, then the customer asked for more time. Timeline shows a due-date change.
  const pending = await createOrder(user._id, {
    customer: 'Northwind Traders',
    dueDate: daysFromToday(15),
    lineItems: [{ description: 'Consulting Services', quantity: 10, unitPriceCents: 15_000 }],
  });
  await updateOrder(user._id, pending._id.toString(), { dueDate: daysFromToday(30) });
  await backdateTrail(pending._id, 12);

  // Overdue — scope grew before anything was paid. Timeline shows an item added and the total
  // moving, plus the status crossing into overdue between two recorded events.
  const overdue = await createOrder(user._id, {
    customer: 'Globex Corp',
    dueDate: daysFromToday(-30),
    lineItems: [{ description: 'Annual License', quantity: 1, unitPriceCents: 200_000 }],
  });
  await updateOrder(user._id, overdue._id.toString(), {
    lineItems: [
      { description: 'Annual License', quantity: 1, unitPriceCents: 200_000 },
      { description: 'Priority Support', quantity: 1, unitPriceCents: 50_000 },
    ],
  });
  await backdateTrail(overdue._id, 45);

  // Partially paid — one instalment landed, then someone tried to pay more than was left.
  // Timeline shows the refusal with what was attempted against what was allowed.
  const partial = await createOrder(user._id, {
    customer: 'Initech LLC',
    dueDate: daysFromToday(45),
    lineItems: [{ description: 'Software Maintenance', quantity: 4, unitPriceCents: 50_000 }],
  });
  await recordPayment(user._id, partial._id.toString(), {
    amountCents: 100_000,
    paidOn: daysFromToday(-5),
    idempotencyKey: 'seed-partial-1',
  });
  try {
    await recordPayment(user._id, partial._id.toString(), {
      amountCents: 150_000, // only $1,000 remains — the guard refuses this
      paidOn: daysFromToday(-4),
      idempotencyKey: 'seed-partial-overpay',
    });
  } catch (err) {
    if (!(err instanceof OverpaymentError)) throw err;
  }
  await backdateTrail(partial._id, 20);

  // Fully paid on time, in two instalments — the timeline shows status stepping from pending to
  // partially paid to paid.
  const paid = await createOrder(user._id, {
    customer: 'Acme Manufacturing',
    dueDate: daysFromToday(5),
    lineItems: [{ description: 'Widget Assembly', quantity: 20, unitPriceCents: 5_000 }],
  });
  await recordPayment(user._id, paid._id.toString(), {
    amountCents: 40_000,
    paidOn: daysFromToday(-9),
    idempotencyKey: 'seed-paid-1',
  });
  await recordPayment(user._id, paid._id.toString(), {
    amountCents: 60_000,
    paidOn: daysFromToday(-2),
    idempotencyKey: 'seed-paid-2',
  });
  await backdateTrail(paid._id, 16);

  // Fully paid, but after its due date — the paidLate case. Edited while overdue and unpaid,
  // which the narrower metadata lock still allows.
  const late = await createOrder(user._id, {
    customer: 'Hooli Incorporated',
    dueDate: daysFromToday(-20),
    lineItems: [{ description: 'Cloud Hosting', quantity: 3, unitPriceCents: 30_000 }],
  });
  await updateOrder(user._id, late._id.toString(), { customer: 'Hooli Inc' });
  await recordPayment(user._id, late._id.toString(), {
    amountCents: 90_000,
    paidOn: daysFromToday(-10),
    idempotencyKey: 'seed-late-1',
  });
  await backdateTrail(late._id, 38);

  console.log('Seeded 5 orders: pending, overdue, partially paid, paid, paid-late.');
  console.log('Each carries a timeline — edits, a refused over-payment, and a two-instalment settlement.');
}

async function main(): Promise<void> {
  // Imported lazily, same reasoning as scripts/bootstrap.ts — importing seed() in a test
  // shouldn't require a full production environment.
  const { env } = await import('../config/env');

  await connectDatabase(env.MONGODB_URI);
  if (process.argv.includes('--reset')) await resetDemo();
  await seed();
  await disconnectDatabase();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
