import type mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models/User';
import { Order } from '../models/Order';
import { Session } from '../models/Session';
import { AuditLog } from '../models/AuditLog';
import { LoginAttempt } from '../models/LoginAttempt';

/**
 * Explicit schema bootstrap — indexes and the orders collection validator.
 *
 * Runs as a deliberate step, never at request time (`autoIndex` is off in config/database.ts).
 * Safe to re-run: index sync is declarative and the validator setup is idempotent.
 *
 *   npm run bootstrap        # local, reads .env.local
 *   npm run bootstrap:prod   # compiled, reads the ambient environment
 */

/**
 * The CHECK-constraint equivalent, and the third layer of the over-payment defence.
 *
 * Layer one is the `$expr` guard in the update predicate; layer two is single-document
 * atomicity. This one means even a hand-rolled write that bypasses the service layer is
 * rejected by the database itself.
 */
const ORDER_VALIDATOR = {
  $expr: { $lte: ['$amountPaidCents', '$totalCents'] },
} as const;

/** MongoDB error code for NamespaceExists. */
const NAMESPACE_EXISTS = 48;

/**
 * Idempotent: try to create, fall back to modifying if it already exists.
 *
 * Deliberately NOT `listCollections` then `createCollection` — that's check-then-act, and it
 * loses to a concurrent deploy or to the driver's own retry (a retried `createCollection` can
 * observe the collection its first attempt created). Same reasoning as letting a unique index
 * reject a duplicate signup rather than pre-checking for one.
 */
async function ensureOrderValidator(db: mongoose.mongo.Db): Promise<string> {
  const options = {
    validator: ORDER_VALIDATOR,
    validationAction: 'error' as const,
    validationLevel: 'strict' as const,
  };

  try {
    await db.createCollection('orders', options);
    return 'created orders collection with over-payment validator';
  } catch (err) {
    if ((err as { code?: number }).code !== NAMESPACE_EXISTS) throw err;
    await db.command({ collMod: 'orders', ...options });
    return 'updated orders collection validator';
  }
}

export async function bootstrap(
  uri: string,
  log: (message: string) => void = console.log,
): Promise<void> {
  const connection = await connectDatabase(uri);
  const db = connection.connection.db;
  if (!db) throw new Error('No database handle after connect');

  log(await ensureOrderValidator(db));

  for (const m of [User, Order, Session, AuditLog, LoginAttempt]) {
    await m.syncIndexes();
    log(`synced indexes: ${m.modelName}`);
  }
}

async function main(): Promise<void> {
  // Imported lazily so importing bootstrap() in tests doesn't require a full production env.
  const { env } = await import('../config/env');

  const redacted = env.MONGODB_URI.replace(/\/\/[^@]+@/, '//***:***@');
  console.log(`Bootstrapping ${redacted}`);

  await bootstrap(env.MONGODB_URI, (msg) => console.log(`  ${msg}`));
  await disconnectDatabase();

  console.log('Bootstrap complete.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  });
}
