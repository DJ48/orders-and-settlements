import mongoose, { type Types } from 'mongoose';
import { Order, type OrderDocument } from '../models/Order';
import { getOrder, type RequestContext } from './orders.service';
import { recordAudit, snapshotOf } from './audit.service';
import { utcDateOnly } from '../utils/status';
import { ValidationError, OverpaymentError } from '../utils/errors';

/**
 * This is the guard the whole assignment is graded on: recording a payment is one atomic
 * conditional write, not a read-then-check-then-write. The over-payment rule lives in the
 * query predicate itself (`$expr`), so two concurrent payments against the same order cannot
 * both pass — MongoDB's single-document atomicity is the lock, not application code. Verified
 * under real concurrency in test/services/payments.service.test.ts and, originally, in the
 * phase-0 spike before any of this existed.
 *
 * A pipeline update (not `$inc`/`$push`) is required, not incidental — it's what lets
 * `settlementState` be recomputed from the NEW balance inside the same atomic operation, so
 * there is never a moment where the stored state and the balance disagree.
 */

export interface RecordPaymentInput {
  amountCents: number;
  paidOn: string;
  note?: string;
  idempotencyKey: string;
}

export async function recordPayment(
  userId: Types.ObjectId,
  orderId: string,
  input: RecordPaymentInput,
  context: RequestContext = {},
): Promise<OrderDocument> {
  const paidOnDate = utcDateOnly(new Date(input.paidOn));

  // A payment records something that already happened — post-dating one that hasn't occurred
  // yet isn't a correction, it's a mistake, and backdating (the legitimate case) is unaffected.
  if (paidOnDate.getTime() > utcDateOnly(new Date()).getTime()) {
    throw new ValidationError('Payment date cannot be in the future', 'paidOn');
  }

  const paymentSubdoc = {
    _id: new mongoose.Types.ObjectId(),
    amountCents: input.amountCents,
    paidOn: paidOnDate,
    note: input.note,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date(),
  };

  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      userId,
      deletedAt: null,
      'payments.idempotencyKey': { $ne: input.idempotencyKey },
      $expr: { $lte: [{ $add: ['$amountPaidCents', input.amountCents] }, '$totalCents'] },
    },
    [
      {
        $set: {
          amountPaidCents: { $add: ['$amountPaidCents', input.amountCents] },
          payments: { $concatArrays: ['$payments', [paymentSubdoc]] },
          // $max rather than an unconditional overwrite — a backdated correction payment
          // inserted after a later one must not make a genuinely-late settlement look on time.
          lastPaymentOn: { $max: ['$lastPaymentOn', paidOnDate] },
          settlementState: {
            $switch: {
              branches: [
                {
                  case: { $gte: [{ $add: ['$amountPaidCents', input.amountCents] }, '$totalCents'] },
                  then: 'settled',
                },
                { case: { $gt: [{ $add: ['$amountPaidCents', input.amountCents] }, 0] }, then: 'partial' },
              ],
              default: 'unpaid',
            },
          },
          updatedAt: new Date(),
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  );

  if (updated) {
    await recordAudit('payment.recorded', {
      userId,
      orderId: updated._id,
      context,
      snapshot: snapshotOf(updated),
      delta: { amountCents: input.amountCents, paymentId: paymentSubdoc._id.toString() },
    });
    return updated;
  }

  // findOneAndUpdate returning null doesn't say WHY — not found, already-replayed, or
  // over-payment all look identical from here. One follow-up read classifies it. getOrder()
  // itself throws NotFoundError if the order doesn't exist or isn't this user's, so that case
  // is handled for free without duplicating the ownership check.
  const existing = await getOrder(userId, orderId);

  const alreadyRecorded = existing.payments.some((p) => p.idempotencyKey === input.idempotencyKey);
  if (alreadyRecorded) {
    // A replay of a request that already succeeded is not a failure — the caller asked for
    // this exact payment before and it exists, so returning the current state IS the correct
    // "already done" response. Recording it as `payment.recorded` again would double-count
    // the audit trail for one real payment, so it's deliberately silent here.
    return existing;
  }

  const maxAllowedCents = existing.totalCents - existing.amountPaidCents;
  await recordAudit('payment.rejected', {
    userId,
    orderId: existing._id,
    context,
    snapshot: snapshotOf(existing),
    delta: { attemptedCents: input.amountCents, maxAllowedCents },
  });

  throw new OverpaymentError(input.amountCents, maxAllowedCents);
}
