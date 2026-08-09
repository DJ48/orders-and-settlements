import { z } from 'zod';

/**
 * Environment is validated once, at startup, and fails loudly.
 *
 * The alternative — reading `process.env.X` at the point of use — means a missing variable
 * surfaces as `undefined` deep inside a request, hours after deploy. Here a bad config kills
 * the process immediately with a message naming the variable.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  /** MongoDB Atlas connection string, including the database name. */
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  /** Origin allowed to call this API with credentials. */
  WEB_ORIGIN: z.string().min(1).default('http://localhost:3000'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
