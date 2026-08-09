import mongoose from 'mongoose';

/**
 * Connection management.
 *
 * The URI is passed in rather than read from `env` here, so tests can point at an in-memory
 * replica set without this module depending on a validated production environment.
 */
let connection: typeof mongoose | null = null;

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  if (connection) return connection;

  // Reject query fields not present in the schema instead of silently ignoring them —
  // a typo'd filter key would otherwise match every document in the collection.
  mongoose.set('strictQuery', true);

  connection = await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,

    // Indexes are created by scripts/bootstrap.ts as an explicit step. Building them on first
    // use is a latency spike and a race between concurrent instances.
    autoIndex: false,
  });

  return connection;
}

export async function disconnectDatabase(): Promise<void> {
  if (!connection) return;
  await connection.disconnect();
  connection = null;
}

export function getConnection(): typeof mongoose {
  if (!connection) {
    throw new Error('Database not connected — call connectDatabase() first');
  }
  return connection;
}
