import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';
import { signup } from '../services/auth.service';
import { createOrder } from '../services/orders.service';
import { recordPayment } from '../services/payments.service';

/**
 * Reproducible local demo data — a demo user plus one order in each status, mirroring exactly
 * what was hand-seeded via curl against the live deployment (see README's demo login).
 *
 *   npm run seed
 *
 * Idempotent by inspection, not by design: if the demo user already exists, the whole seed is
 * skipped rather than attempting to dedupe orders too. That's the right tradeoff for a local dev
 * convenience script (re-running it is harmless), not a production migration.
 */

export const DEMO_EMAIL = 'demo@ordersandsettlements.com';
export const DEMO_PASSWORD = 'DemoPass123!';

function daysFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export async function seed(): Promise<void> {
  const existing = await User.findOne({ email: DEMO_EMAIL });
  if (existing) {
    console.log(`Demo user ${DEMO_EMAIL} already exists — skipping. Delete it to re-seed.`);
    return;
  }

  const user = await signup({ email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo Reviewer' });
  console.log(`Created demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

  // Pending — due in the future, unpaid.
  await createOrder(user._id, {
    customer: 'Northwind Traders',
    dueDate: daysFromToday(30),
    lineItems: [{ description: 'Consulting Services', quantity: 10, unitPriceCents: 15_000 }],
  });

  // Overdue — due in the past, unpaid.
  await createOrder(user._id, {
    customer: 'Globex Corp',
    dueDate: daysFromToday(-30),
    lineItems: [{ description: 'Annual License', quantity: 1, unitPriceCents: 250_000 }],
  });

  // Partially paid — due in the future, still on track.
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

  // Fully paid, on time.
  const paid = await createOrder(user._id, {
    customer: 'Acme Manufacturing',
    dueDate: daysFromToday(5),
    lineItems: [{ description: 'Widget Assembly', quantity: 20, unitPriceCents: 5_000 }],
  });
  await recordPayment(user._id, paid._id.toString(), {
    amountCents: 100_000,
    paidOn: daysFromToday(-2),
    idempotencyKey: 'seed-paid-1',
  });

  // Fully paid, but after its due date — the paidLate edge case.
  const late = await createOrder(user._id, {
    customer: 'Hooli Inc',
    dueDate: daysFromToday(-20),
    lineItems: [{ description: 'Cloud Hosting', quantity: 3, unitPriceCents: 30_000 }],
  });
  await recordPayment(user._id, late._id.toString(), {
    amountCents: 90_000,
    paidOn: daysFromToday(-10),
    idempotencyKey: 'seed-late-1',
  });

  console.log('Seeded 5 orders: pending, overdue, partially paid, paid, paid-late.');
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
