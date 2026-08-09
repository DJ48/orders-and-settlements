import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * Brute-force throttling for login.
 *
 * Stored in MongoDB rather than in process memory so it survives restarts and works if the API
 * is ever run as more than one instance. Mongo's TTL monitor expires the rows, so there's no
 * cleanup job to own.
 */
const LoginAttemptSchema = new Schema(
  {
    /** `email:ip` */
    _id: { type: String, required: true },

    attempts: { type: Number, required: true, default: 0 },
    firstAttemptAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

LoginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type LoginAttemptDoc = InferSchemaType<typeof LoginAttemptSchema>;

export const LoginAttempt: Model<LoginAttemptDoc> =
  (models.LoginAttempt as Model<LoginAttemptDoc>) ??
  model<LoginAttemptDoc>('LoginAttempt', LoginAttemptSchema);
