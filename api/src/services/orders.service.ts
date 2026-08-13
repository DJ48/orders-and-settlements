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
  /** Both optional, both already normalised to UTC midnight by the caller — same "both or
   *  neither" contract as exportOrders. Intersected with whatever dueDate bound `status` itself
   *  implies (see mergeDueDateBounds), not just appended alongside it. */
  dueDateFrom?: Date;
  dueDateTo?: Date;
  page?: number;
  pageSize?: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * `statusFilter('pending'|'partially_paid')` already constrains dueDate to `$gte: today`, and
 * `statusFilter('overdue')` to `$lt: today`. A caller-supplied range touches the same field, so
 * naively spreading both fragments would let whichever came second silently clobber the other's
 * bound instead of intersecting it — most dangerously on `$gte`, where both a status and a range
 * can each supply one. `$lt` and `$lte` never collide (only overdue ever sets `$lt`, only a
 * range ever sets `$lte`), so those simply coexist as separate keys; only `$gte` needs an
 * explicit max().
 */
function mergeDueDateBounds(
  statusDueDate: { $lt?: Date; $gte?: Date } | undefined,
  from: Date | undefined,
  to: Date | undefined,
): Record<string, Date> | undefined {
  const bounds: Record<string, Date> = {};

  if (statusDueDate?.$lt) bounds.$lt = statusDueDate.$lt;
  if (statusDueDate?.$gte) bounds.$gte = statusDueDate.$gte;

  if (from) bounds.$gte = bounds.$gte && bounds.$gte > from ? bounds.$gte : from;
  if (to) bounds.$lte = to;

  return Object.keys(bounds).length > 0 ? bounds : undefined;
}

/**
 * Shared by listOrders and exportOrders so the two can never quietly diverge on what "the
 * current filter" means — a status + date-range combination that shows one set of orders on the
 * dashboard must export exactly that same set, not a looser one.
 */
function buildOrderFilter(
  userId: Types.ObjectId,
  options: { status?: OrderStatus; dueDateFrom?: Date; dueDateTo?: Date },
  now: Date = new Date(),
): Record<string, unknown> {
  const filter: Record<string, unknown> = { userId, deletedAt: null };

  if (options.status) {
    const { dueDate: statusDueDate, ...rest } = statusFilter(options.status, now) as {
      dueDate?: { $lt?: Date; $gte?: Date };
    } & Record<string, unknown>;
    Object.assign(filter, rest);
    const merged = mergeDueDateBounds(statusDueDate, options.dueDateFrom, options.dueDateTo);
    if (merged) filter.dueDate = merged;
  } else {
    const merged = mergeDueDateBounds(undefined, options.dueDateFrom, options.dueDateTo);
    if (merged) filter.dueDate = merged;
  }

  return filter;
}

/**
 * Excludes `lineItems`/`payments` at the QUERY level, not just at response time — that's what
 * makes this an index-covered read rather than pulling every embedded array for every row.
 * Sort tracks whichever compound index the filter uses (see Order.ts): filtered by status or a
 * date range, dueDate is the index's trailing field; otherwise createdAt is.
 *
 * `summary` runs as a second query against the identical filter (not the paginated page) — it's
 * the only way "Total value" and "Overdue" stay correct once there's more than one page. It
 * duplicates the overdue *condition* from statusFilter()/deriveStatus() as a Mongo aggregation
 * expression rather than sharing code with them: it's the same rule expressed in Mongo's query
 * language instead of JS, for a dashboard summary rather than a single order's authoritative
 * status, which is still always computed by deriveStatus() per-order in the response layer.
 */
export async function listOrders(userId: Types.ObjectId, options: ListOrdersOptions = {}) {
  const now = new Date();
  const filter = buildOrderFilter(userId, options, now);

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const today = utcDateOnly(now);
  const sortField: Record<string, 1 | -1> =
    options.status || options.dueDateFrom || options.dueDateTo ? { dueDate: 1 } : { createdAt: -1 };

  const [orders, summaryRows] = await Promise.all([
    Order.find(filter)
      .select('-lineItems -payments')
      .sort(sortField)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Order.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalValueCents: { $sum: '$totalCents' },
          outstandingCents: { $sum: { $max: [0, { $subtract: ['$totalCents', '$amountPaidCents'] }] } },
          overdueCount: {
            $sum: {
              $cond: [
                { $and: [{ $in: ['$settlementState', ['unpaid', 'partial']] }, { $lt: ['$dueDate', today] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const summaryRow = summaryRows[0] as
    | { count: number; totalValueCents: number; outstandingCents: number; overdueCount: number }
    | undefined;
  const total = summaryRow?.count ?? 0;

  return {
    orders,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary: {
      totalValueCents: summaryRow?.totalValueCents ?? 0,
      outstandingCents: summaryRow?.outstandingCents ?? 0,
      overdueCount: summaryRow?.overdueCount ?? 0,
    },
  };
}

export interface ExportOrdersOptions {
  status?: OrderStatus;
  /** Both optional and both already normalised to UTC midnight by the caller. Omitting both
   *  means no date filter; the controller's validation guarantees they're never supplied one
   *  without the other. */
  from?: Date;
  to?: Date;
}

/**
 * Built from the exact same filter as listOrders (via buildOrderFilter) — a status + date range
 * that shows one set of orders on the dashboard must export that same set, not a looser one that
 * ignores the status chip. Unbounded by pagination, unlike the dashboard's page-at-a-time view;
 * capped at 5,000 as a hard safety limit rather than real pagination, same posture as before.
 */
export async function exportOrders(userId: Types.ObjectId, options: ExportOrdersOptions = {}) {
  const filter = buildOrderFilter(userId, {
    status: options.status,
    dueDateFrom: options.from,
    dueDateTo: options.to,
  });

  return Order.find(filter)
    .select('-lineItems -payments')
    .sort({ dueDate: 1 })
    .limit(5_000)
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

/**
 * The comparable shape of an order's items — `lineTotalCents` is omitted because it's derived
 * from quantity × unitPrice, so including it would just double-count a change already visible.
 */
function lineItemsFor(order: OrderDocument) {
  return order.lineItems.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
  }));
}

export async function updateOrder(
  userId: Types.ObjectId,
  orderId: string,
  patch: UpdateOrderInput,
  context: RequestContext = {},
): Promise<OrderDocument> {
  const order = await getOrder(userId, orderId);
  let changed = false;

  // Captured before any mutation. Recording only the incoming patch would store what a field
  // BECAME but never what it WAS, which makes the trail unable to answer the one question an
  // audit trail exists for: what changed. Cheap to keep — three scalars and the item count.
  const before = {
    customer: order.customer,
    dueDate: order.dueDate,
    totalCents: order.totalCents,
    lineItems: lineItemsFor(order),
  };

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

  // Only fields that actually moved. A patch can name a field and set it to what it already was;
  // recording that as a change would put a row on the timeline saying nothing happened.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (before.customer !== order.customer) {
    changes.customer = { from: before.customer, to: order.customer };
  }
  if (before.dueDate.getTime() !== order.dueDate.getTime()) {
    changes.dueDate = { from: before.dueDate.toISOString(), to: order.dueDate.toISOString() };
  }
  // Compared by content, not by count and total: renaming an item or swapping quantity against
  // unit price for the same money leaves both of those identical while the order genuinely
  // changed, which previously produced an "Order updated" row that couldn't say what moved.
  const afterItems = lineItemsFor(order);
  if (JSON.stringify(before.lineItems) !== JSON.stringify(afterItems)) {
    changes.lineItems = {
      from: { count: before.lineItems.length, totalCents: before.totalCents, items: before.lineItems },
      to: { count: afterItems.length, totalCents: order.totalCents, items: afterItems },
    };
  }

  await recordAudit('order.updated', {
    userId,
    orderId: order._id,
    context,
    snapshot: snapshotOf(order),
    delta: { changes },
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
