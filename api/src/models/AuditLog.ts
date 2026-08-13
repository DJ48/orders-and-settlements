import { Schema, model, models, type InferSchemaType, type Model, type Types } from 'mongoose';

export const AUDIT_ACTIONS = [
  'order.created',
  'order.updated',
  'order.deleted',
  'payment.recorded',
  /** Refused over-payments are audit signal AND abuse signal. Recording them costs nothing. */
  'payment.rejected',
  'auth.signup',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.logout',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * A separate collection because its profile is the opposite of an order's on every axis:
 * unbounded growth, append-only, never updated, queried by time and actor rather than by order.
 * Embedding these would bloat the document that sits on the hot path.
 *
 * No TTL — a financial audit trail should not quietly delete itself. Archiving to object
 * storage with lifecycle rules is the production answer.
 */
const AuditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },

  /** Null for auth events, which have no order. */
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },

  action: { type: String, enum: AUDIT_ACTIONS, required: true },
  at: { type: Date, required: true, default: () => new Date() },

  /** Correlates with the requestId echoed in every error response. */
  requestId: { type: String, maxlength: 64 },

  actor: {
    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 400 },
  },

  /** After-state only — copying whole documents would balloon this collection. */
  snapshot: {
    totalCents: { type: Number },
    amountPaidCents: { type: Number },
    settlementState: { type: String },
  },

  /**
   * Shape varies by action: `{ amountCents, paymentId }` for a recorded payment,
   * `{ attemptedCents, maxAllowedCents }` for a rejected one. The one deliberately schemaless
   * field in the system, and the concrete answer to "why a document store for events".
   */
  delta: { type: Schema.Types.Mixed },
});

AuditLogSchema.index({ userId: 1, at: -1 });
AuditLogSchema.index({ orderId: 1, at: -1 });

export type AuditLogDoc = InferSchemaType<typeof AuditLogSchema>;

/** What `.lean()` actually hands back: the inferred shape plus the `_id` Mongoose always adds. */
export type LeanAuditLog = AuditLogDoc & { _id: Types.ObjectId };

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc>) ?? model<AuditLogDoc>('AuditLog', AuditLogSchema);
