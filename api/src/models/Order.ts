import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { MAX_LINE_ITEMS } from '../utils/totals';

const wholeNumber = {
  validator: Number.isInteger,
  message: '{PATH} must be a whole number of cents',
};

/**
 * Line items are embedded: composition, not association. They have no independent lifecycle,
 * become immutable once a payment lands, and are never queried on their own.
 */
const LineItemSchema = new Schema({
  description: { type: String, required: true, trim: true, maxlength: 200 },
  quantity: { type: Number, required: true, min: 1, validate: wholeNumber },
  unitPriceCents: { type: Number, required: true, min: 0, validate: wholeNumber },
  lineTotalCents: { type: Number, required: true, min: 0, validate: wholeNumber },
});

/**
 * Payments are embedded for CORRECTNESS, not convenience. The invariant `Σpayments ≤ total`
 * spans the payment and the running balance, so embedding puts both in one document and makes
 * the guard a single atomic write — no transaction, no lock, no read-modify-write window.
 *
 * Payments are append-only: never edited, never deleted. Corrections happen through a refund
 * entity so history is never rewritten.
 */
const PaymentSchema = new Schema({
  amountCents: { type: Number, required: true, min: 1, validate: wholeNumber },

  /** Business date the payment was made — drives overdue and paid-late logic. */
  paidOn: { type: Date, required: true },

  note: { type: String, trim: true, maxlength: 500 },
  idempotencyKey: { type: String, required: true, maxlength: 64 },

  /** System time it was recorded. Deliberately distinct from `paidOn`. */
  createdAt: { type: Date, required: true, default: () => new Date() },
});

const OrderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * The billed party — NOT the account holder. Stored as a string even though a mature
     * system would add a `customers` collection, because an order is a point-in-time financial
     * document: if a customer renames, historical orders must keep the name they were issued
     * under. Resolving it through a join would silently rewrite financial history.
     */
    customer: { type: String, required: true, trim: true, maxlength: 200 },

    /** Date-only, normalised to UTC midnight before write. */
    dueDate: { type: Date, required: true },

    lineItems: {
      type: [LineItemSchema],
      required: true,
      validate: {
        validator: (v: unknown[]) => v.length >= 1 && v.length <= MAX_LINE_ITEMS,
        message: `An order needs between 1 and ${MAX_LINE_ITEMS} line items`,
      },
    },
    payments: { type: [PaymentSchema], default: [] },

    subtotalCents: { type: Number, required: true, min: 1, validate: wholeNumber },

    /** Equals subtotal today; a separate field marks where tax and discounts would apply. */
    totalCents: { type: Number, required: true, min: 1, validate: wholeNumber },

    /**
     * The invariant-bearing scalar. The `payments` array is a history log; THIS is the balance.
     * Keeping them separate is what would let the history move to its own collection later
     * without touching any correctness logic.
     */
    amountPaidCents: { type: Number, required: true, default: 0, min: 0, validate: wholeNumber },

    /**
     * Index accelerator, storage only, never returned by the API. Encodes the money axis alone,
     * so it cannot go stale — the time axis is applied at query time.
     */
    settlementState: {
      type: String,
      enum: ['unpaid', 'partial', 'settled'],
      required: true,
      default: 'unpaid',
    },

    /** Business date of the latest payment — lets the list view compute paidLate without the array. */
    lastPaymentOn: { type: Date, default: null },

    /** Bumped only when the order's own attributes change. Payments do not touch it. */
    orderModifiedAt: { type: Date, required: true, default: () => new Date() },

    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true, // `updatedAt` is technical — any write. Never displayed.
    optimisticConcurrency: true, // lost-update protection on the edit path, via `__v`
  },
);

/** Dashboard list and every status filter. ESR: equality fields first, range/sort last. */
OrderSchema.index({ userId: 1, deletedAt: 1, settlementState: 1, dueDate: 1 });

/** Default "newest first" ordering. */
OrderSchema.index({ userId: 1, deletedAt: 1, createdAt: -1 });

/**
 * Idempotent payment submission.
 *
 * Note: a unique multikey index constrains values ACROSS documents; MongoDB permits duplicates
 * within a single document's array. In-document idempotency is enforced by the `$ne` clause in
 * the atomic update, which is part of the same operation and therefore sufficient. This index
 * is belt-and-braces across orders.
 */
OrderSchema.index(
  { userId: 1, 'payments.idempotencyKey': 1 },
  { unique: true, partialFilterExpression: { 'payments.idempotencyKey': { $exists: true } } },
);

export type OrderDoc = InferSchemaType<typeof OrderSchema>;
export type LineItemDoc = InferSchemaType<typeof LineItemSchema>;
export type PaymentDoc = InferSchemaType<typeof PaymentSchema>;

export const Order: Model<OrderDoc> =
  (models.Order as Model<OrderDoc>) ?? model<OrderDoc>('Order', OrderSchema);
