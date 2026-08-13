import type { Types } from 'mongoose';
import { AuditLog, type AuditAction, type LeanAuditLog } from '../models/AuditLog';
import type { OrderDocument } from '../models/Order';
import type { RequestContext } from './auth.service';

/**
 * Shared by every service that writes an order-scoped audit entry — orders.service.ts and
 * payments.service.ts both need the identical shape, and letting that logic drift between two
 * copies is exactly the kind of duplication this project has avoided everywhere else.
 */
export async function recordAudit(
  action: AuditAction,
  opts: {
    userId: Types.ObjectId;
    orderId: Types.ObjectId;
    context?: RequestContext;
    snapshot?: { totalCents: number; amountPaidCents: number; settlementState: string; dueDate: Date };
    delta?: Record<string, unknown>;
  },
): Promise<void> {
  await AuditLog.create({
    userId: opts.userId,
    orderId: opts.orderId,
    action,
    requestId: opts.context?.requestId,
    actor: { ip: opts.context?.ip, userAgent: opts.context?.userAgent },
    snapshot: opts.snapshot,
    delta: opts.delta,
  });
}

/**
 * One order's trail, newest first — served by the `{ orderId, at: -1 }` index the collection has
 * carried since it was introduced.
 *
 * Ownership is NOT enforced here by adding `userId` to the filter, deliberately: that would make
 * someone else's order return an empty timeline, which reads as "nothing ever happened" rather
 * than "not yours". The caller resolves the order through getOrder() first, so a foreign or
 * missing id raises the same 404 as every other order route (see Ownership in the README).
 *
 * Capped rather than paginated. An order's event count is bounded by how many times a human
 * touched it, so the limit is a safety rail against a pathological document, not real pagination.
 */
export async function listOrderAudit(orderId: Types.ObjectId): Promise<LeanAuditLog[]> {
  return AuditLog.find({ orderId }).sort({ at: -1 }).limit(200).lean();
}

export function snapshotOf(order: OrderDocument) {
  return {
    totalCents: order.totalCents,
    amountPaidCents: order.amountPaidCents,
    settlementState: order.settlementState,
    dueDate: order.dueDate,
  };
}
