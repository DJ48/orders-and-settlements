import type { Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { signup } from '../services/auth.service';
import { createOrder, updateOrder } from '../services/orders.service';
import { recordPayment } from '../services/payments.service';
import { OverpaymentError } from '../utils/errors';

/**
 * Reproducible demo data.
 *
 *   npm run seed
 *
 * Seeds two independent accounts with the same *shape* of data under different customer names.
 * They exist so a walkthrough recording and a reviewer clicking around can't collide: recording a
 * payment during a demo permanently changes that order's state, and doing that to the account a
 * reviewer is also using would rewrite what they're looking at mid-session.
 *
 * Every order is built through the real service functions, never raw writes, so the audit trail
 * these produce is the same trail the running app produces. Each carries a different shape of
 * history — an edit, a refused payment, a settlement in two instalments — because the order
 * timeline is only worth looking at if there's something on it.
 *
 * Idempotent by inspection, not by design: an account whose user already exists is skipped whole
 * rather than deduped order by order. That's the right tradeoff for a convenience script, not a
 * production migration. To rebuild, delete the users first — deliberately a manual step, since a
 * flag that erases accounts is not something a seed script should carry.
 */

export interface SeedAccount {
  email: string;
  password: string;
  name: string;
  /**
   * Distinct per account, so which one is on screen is obvious at a glance. `lateBefore` is the
   * name that order was raised under before being corrected, so its timeline has a real rename.
   */
  customers: {
    pending: string;
    overdue: string;
    partial: string;
    paid: string;
    late: string;
    lateBefore: string;
  };
}

/** Documented in the README and handed to the reviewer. */
export const DEMO_ACCOUNT: SeedAccount = {
  email: 'demo@ordersandsettlements.com',
  password: 'DemoPass123!',
  name: 'Demo Reviewer',
  customers: {
    pending: 'Northwind Traders',
    overdue: 'Globex Corp',
    partial: 'Initech LLC',
    paid: 'Acme Manufacturing',
    late: 'Hooli Inc',
    lateBefore: 'Hooli Incorporated',
  },
};

/** Kept separate so a walkthrough can record payments without touching the reviewer's data. */
export const VIDEO_ACCOUNT: SeedAccount = {
  email: 'video@ordersandsettlements.com',
  password: 'VideoPass123!',
  name: 'Walkthrough Host',
  customers: {
    pending: 'Stark Industries',
    overdue: 'Umbrella Corporation',
    partial: 'Cyberdyne Systems',
    paid: 'Wayne Enterprises',
    late: 'Tyrell Corp',
    lateBefore: 'Tyrell Corporation',
  },
};

export const SEED_ACCOUNTS = [DEMO_ACCOUNT, VIDEO_ACCOUNT];

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
 * history rather than several events in the same second.
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

async function seedAccount(account: SeedAccount): Promise<void> {
  const existing = await User.findOne({ email: account.email });
  if (existing) {
    console.log(`${account.email} already exists — skipping.`);
    return;
  }

  const user = await signup({ email: account.email, password: account.password, name: account.name });
  const { customers } = account;

  // Pending — created, then the customer asked for more time. Timeline shows a due-date change.
  const pending = await createOrder(user._id, {
    customer: customers.pending,
    dueDate: daysFromToday(15),
    lineItems: [{ description: 'Consulting Services', quantity: 10, unitPriceCents: 15_000 }],
  });
  await updateOrder(user._id, pending._id.toString(), { dueDate: daysFromToday(30) });
  await backdateTrail(pending._id, 12);

  // Overdue — scope grew before anything was paid. Timeline shows an item added and the total
  // moving, plus the status crossing into overdue between two recorded events.
  const overdue = await createOrder(user._id, {
    customer: customers.overdue,
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
    customer: customers.partial,
    dueDate: daysFromToday(45),
    lineItems: [{ description: 'Software Maintenance', quantity: 4, unitPriceCents: 50_000 }],
  });
  await recordPayment(user._id, partial._id.toString(), {
    amountCents: 100_000,
    paidOn: daysFromToday(-5),
    idempotencyKey: `${account.email}-partial-1`,
  });
  try {
    await recordPayment(user._id, partial._id.toString(), {
      amountCents: 150_000, // only $1,000 remains — the guard refuses this
      paidOn: daysFromToday(-4),
      idempotencyKey: `${account.email}-partial-overpay`,
    });
  } catch (err) {
    if (!(err instanceof OverpaymentError)) throw err;
  }
  await backdateTrail(partial._id, 20);

  // Fully paid on time, in two instalments — the timeline shows status stepping from pending to
  // partially paid to paid.
  const paid = await createOrder(user._id, {
    customer: customers.paid,
    dueDate: daysFromToday(5),
    lineItems: [{ description: 'Widget Assembly', quantity: 20, unitPriceCents: 5_000 }],
  });
  await recordPayment(user._id, paid._id.toString(), {
    amountCents: 40_000,
    paidOn: daysFromToday(-9),
    idempotencyKey: `${account.email}-paid-1`,
  });
  await recordPayment(user._id, paid._id.toString(), {
    amountCents: 60_000,
    paidOn: daysFromToday(-2),
    idempotencyKey: `${account.email}-paid-2`,
  });
  await backdateTrail(paid._id, 16);

  // Fully paid, but after its due date — the paidLate case. Edited while overdue and unpaid,
  // which the narrower metadata lock still allows.
  const late = await createOrder(user._id, {
    customer: customers.lateBefore,
    dueDate: daysFromToday(-20),
    lineItems: [{ description: 'Cloud Hosting', quantity: 3, unitPriceCents: 30_000 }],
  });
  await updateOrder(user._id, late._id.toString(), { customer: customers.late });
  await recordPayment(user._id, late._id.toString(), {
    amountCents: 90_000,
    paidOn: daysFromToday(-10),
    idempotencyKey: `${account.email}-late-1`,
  });
  await backdateTrail(late._id, 38);

  console.log(`Seeded ${account.email} / ${account.password} — 5 orders, one per status.`);
}

export async function seed(): Promise<void> {
  for (const account of SEED_ACCOUNTS) {
    await seedAccount(account);
  }
}

async function main(): Promise<void> {
  // Imported lazily, same reasoning as scripts/bootstrap.ts — importing seed() in a test
  // shouldn't require a full production environment.
  const { env } = await import('../config/env');

  await connectDatabase(env.MONGODB_URI);
  await seed();
  await disconnectDatabase();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
