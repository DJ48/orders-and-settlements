import mongoose, { type Types } from 'mongoose';
import { Order, type OrderDocument } from '../models/Order';
import { computeTotals, type LineItemInput } from '../utils/totals';
import { MoneyError } from '../utils/money';
import { utcDateOnly, statusFilter, deriveStatus, type OrderStatus } from '../utils/status';
import { NotFoundError, ValidationError, OrderLockedError, ConflictError } from '../utils/errors';
import { recordAudit, snapshotOf } from './audit.service';
import type { RequestContext } from './auth.service';

export type { RequestContext };

/**
 * Every function here takes `userId` as its first argument, sourced only from the session by
 * the controller. Ownership is enforced in the query predicate (`{ _id, userId, deletedAt:
 * null }`), never checked after the fact — a service that can't be called without a userId
 * can't accidentally return someone else's data. A miss is always NotFoundError, never a
 * distinguishable "exists but isn't yours", so the API never confirms which IDs exist.
 */

/** Never trust a client-supplied total — this is the only place totals are computed. */
function computeTotalsOrThrow(lineItems: LineItemInput[]) {
  try {
    return computeTotals(lineItems);
  } catch (err) {
    if (err instanceof MoneyError) throw new ValidationError(err.message, 'lineItems');
    throw err;
  }
}

/**
 * Malformed IDs are rejected before they ever reach Mongoose — a raw findOne with a bad
 * ObjectId string throws a CastError, and handling that as a special case would just be a more
 * roundabout way of saying the same thing: this ID does not resolve to an order of yours.
 */
function assertValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw new NotFoundError('Order not found');
}

export interface ListOrdersOptions {
  status?: OrderStatus;
}

/**
 * Excludes `lineItems`/`payments` at the QUERY level, not just at response time — that's what
 * makes this an index-covered read rather than pulling every embedded array for every row.
 * Sort tracks whichever compound index the filter uses (see Order.ts): filtered by status,
 * dueDate is the index's trailing field; unfiltered, createdAt is.
 */
export async function listOrders(userId: Types.ObjectId, options: ListOrdersOptions = {}) {
  const filter: Record<string, unknown> = { userId, deletedAt: null };

  if (options.status) {
    return Order.find({ ...filter, ...statusFilter(options.status) })
      .select('-lineItems -payments')
      .sort({ dueDate: 1 })
      .limit(500) // a hard safety cap, not real pagination — documented cut for the deadline
      .lean();
  }

  return Order.find(filter)
    .select('-lineItems -payments')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
}

export interface ExportOrdersOptions {
  /** Both already normalised to UTC midnight by the caller — same convention as dueDate itself. */
  from: Date;
  to: Date;
}

/**
 * A range on `dueDate` alone, filtered by the caller-supplied window rather than a status. Kept
 * separate from `listOrders` rather than folded into it — the two don't share a shape (one takes
 * a status, the other a date range) and forcing them into one function's branches would just
 * make both harder to read for no shared behaviour beyond the ownership predicate.
 */
export async function exportOrdersInRange(userId: Types.ObjectId, options: ExportOrdersOptions) {
  return Order.find({
    userId,
    deletedAt: null,
    dueDate: { $gte: options.from, $lte: options.to },
  })
    .select('-lineItems -payments')
    .sort({ dueDate: 1 })
    .limit(5_000) // generous hard safety cap, not real pagination — same posture as listOrders
    .lean();
}

export async function getOrder(userId: Types.ObjectId, orderId: string): Promise<OrderDocument> {
  assertValidId(orderId);

  const order = await Order.findOne({ _id: orderId, userId, deletedAt: null });
  if (!order) throw new NotFoundError('Order not found');

  return order;
}

export interface CreateOrderInput {
  customer: string;
  dueDate: string;
  lineItems: LineItemInput[];
}

export async function createOrder(
  userId: Types.ObjectId,
  input: CreateOrderInput,
  context: RequestContext = {},
): Promise<OrderDocument> {
  const totals = computeTotalsOrThrow(input.lineItems);

  const order = await Order.create({
    userId,
    customer: input.customer.trim(),
    dueDate: utcDateOnly(new Date(input.dueDate)),
    lineItems: totals.lineItems,
    subtotalCents: totals.subtotalCents,
    totalCents: totals.totalCents,
  });

  await recordAudit('order.created', {
    userId,
    orderId: order._id,
    context,
    snapshot: snapshotOf(order),
  });

  return order;
}

export interface UpdateOrderInput {
  customer?: string;
  dueDate?: string;
  lineItems?: LineItemInput[];
}

export async function updateOrder(
  userId: Types.ObjectId,
  orderId: string,
  patch: UpdateOrderInput,
  context: RequestContext = {},
): Promise<OrderDocument> {
  const order = await getOrder(userId, orderId);
  let changed = false;

  // Line items lock the moment any money exists against this specific total — the lock lives
  // on the scalar (amountPaidCents), not the array, so this never needs to load `payments` and
  // can't disagree with it, since both change atomically together.
  if (patch.lineItems) {
    if (order.amountPaidCents > 0) {
      throw new OrderLockedError();
    }

    const totals = computeTotalsOrThrow(patch.lineItems);
    order.set('lineItems', totals.lineItems);
    order.subtotalCents = totals.subtotalCents;
    order.totalCents = totals.totalCents;
    changed = true;
  }

  // Customer/dueDate get a narrower lock than line items: they only gate something that's
  // already true and could be silently rewritten — a fully-paid order's `paidLate` flag, or an
  // already-overdue order's overdue-ness, both derived from dueDate. A partially-paid order
  // that's still on track has nothing at risk yet, so extending its terms stays allowed; an
  // overdue order with zero payments recorded has no payment history to protect either.
  if (patch.customer !== undefined || patch.dueDate !== undefined) {
    const currentStatus = deriveStatus({
      amountPaidCents: order.amountPaidCents,
      totalCents: order.totalCents,
      dueDate: order.dueDate,
    });
    if (order.amountPaidCents > 0 && (currentStatus === 'paid' || currentStatus === 'overdue')) {
      throw new OrderLockedError();
    }
  }

  if (patch.customer !== undefined) {
    order.customer = patch.customer.trim();
    changed = true;
  }

  if (patch.dueDate !== undefined) {
    order.dueDate = utcDateOnly(new Date(patch.dueDate));
    changed = true;
  }

  if (!changed) return order;

  order.orderModifiedAt = new Date();

  try {
    await order.save();
  } catch (err) {
    // optimisticConcurrency (the schema's __v check) throws this on a lost-update race —
    // two edits to the same order at once. A clear 409 beats a raw 500 here.
    if (err instanceof mongoose.Error.VersionError) {
      throw new ConflictError('This order was changed by another request. Please refresh and try again.');
    }
    throw err;
  }

  await recordAudit('order.updated', {
    userId,
    orderId: order._id,
    context,
    snapshot: snapshotOf(order),
    delta: patch as Record<string, unknown>,
  });

  return order;
}

export async function deleteOrder(
  userId: Types.ObjectId,
  orderId: string,
  context: RequestContext = {},
): Promise<void> {
  const order = await getOrder(userId, orderId);

  if (order.amountPaidCents > 0) {
    throw new OrderLockedError(
      'This order cannot be deleted because payments have been recorded against it',
    );
  }

  order.deletedAt = new Date();

  try {
    await order.save();
  } catch (err) {
    if (err instanceof mongoose.Error.VersionError) {
      throw new ConflictError('This order was changed by another request. Please refresh and try again.');
    }
    throw err;
  }

  await recordAudit('order.deleted', { userId, orderId: order._id, context, snapshot: snapshotOf(order) });
}
