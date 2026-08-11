import type { Types } from 'mongoose';
import { AuditLog, type AuditAction } from '../models/AuditLog';
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
    snapshot?: { totalCents: number; amountPaidCents: number; settlementState: string };
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

export function snapshotOf(order: OrderDocument) {
  return {
    totalCents: order.totalCents,
    amountPaidCents: order.amountPaidCents,
    settlementState: order.settlementState,
  };
}
