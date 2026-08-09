import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * One login = one session.
 *
 * `_id` is the SHA-256 of the raw session token. The raw value is sent to the client once and
 * never stored, so a database leak does not hand over live sessions — the same reasoning that
 * applies to password hashes.
 *
 * Revocation is what a stateless JWT cannot give you: logout deletes the row and the session is
 * dead on the next request, with no waiting for an expiry window.
 */
const SessionSchema = new Schema(
  {
    /** SHA-256 hex of the raw token. */
    _id: { type: String, required: true },

    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    createdAt: { type: Date, required: true, default: () => new Date() },

    /** Idle window, slid forward on use. */
    expiresAt: { type: Date, required: true },

    /** Absolute ceiling — survives sliding, so even a continuously active session ends. */
    absoluteExpiresAt: { type: Date, required: true },

    lastUsedAt: { type: Date, required: true, default: () => new Date() },

    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 400 },
  },
  { _id: false },
);

/** "Sign out everywhere". */
SessionSchema.index({ userId: 1 });

/** Mongo expires the rows itself, so there is no cleanup job to own. */
SessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = InferSchemaType<typeof SessionSchema>;

export const Session: Model<SessionDoc> =
  (models.Session as Model<SessionDoc>) ?? model<SessionDoc>('Session', SessionSchema);
