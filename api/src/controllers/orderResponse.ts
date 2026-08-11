import { deriveStatus, amountDueCents, isPaidLate } from '../utils/status';
import type { OrderDocument } from '../models/Order';

/**
 * Shared by orders.controller.ts and payments.controller.ts — both need to shape an Order
 * document into the exact same API contract, and recording a payment returns the updated order
 * just like the orders endpoints do. The derived fields (status, amountDueCents, paidLate,
 * canEditLineItems) are computed here rather than stored, so every response is guaranteed
 * consistent with the pure functions in utils/status.ts — there's no separate "status" field on
 * the document that could disagree with them.
 */

interface DerivableOrderFields {
  amountPaidCents: number;
  totalCents: number;
  dueDate: Date;
  lastPaymentOn?: Date | null;
}

function derivedFields(order: DerivableOrderFields) {
  const status = deriveStatus({
    amountPaidCents: order.amountPaidCents,
    totalCents: order.totalCents,
    dueDate: order.dueDate,
  });

  return {
    status,
    amountDueCents: amountDueCents(order.amountPaidCents, order.totalCents),
    paidLate: isPaidLate(order.lastPaymentOn, order.dueDate, order.amountPaidCents, order.totalCents),
    // Lives on the scalar, not the payments array — amountPaidCents and payments.length can
    // never disagree, since both change together in the same atomic write.
    canEditLineItems: order.amountPaidCents === 0,
    // Narrower than canEditLineItems: customer/dueDate stay editable through partially_paid as
    // long as the order isn't overdue yet — there's nothing already-true for an edit to
    // silently rewrite until the order is fully paid (paidLate) or overdue (with money at
    // stake). Must match the guard in orders.service.ts#updateOrder exactly, or the UI would
    // show fields as editable that the server then rejects.
    canEditMetadata: !(order.amountPaidCents > 0 && (status === 'paid' || status === 'overdue')),
  };
}

export interface OrderSummaryLean {
  _id: unknown;
  customer: string;
  dueDate: Date;
  subtotalCents: number;
  totalCents: number;
  amountPaidCents: number;
  lastPaymentOn?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toOrderSummaryResponse(order: OrderSummaryLean) {
  return {
    _id: String(order._id),
    customer: order.customer,
    dueDate: order.dueDate.toISOString(),
    subtotalCents: order.subtotalCents,
    totalCents: order.totalCents,
    amountPaidCents: order.amountPaidCents,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    ...derivedFields(order),
  };
}

export function toOrderResponse(order: OrderDocument) {
  return {
    ...toOrderSummaryResponse(order),
    lineItems: order.lineItems.map((line) => ({
      _id: String(line._id),
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
    })),
    payments: order.payments.map((payment) => ({
      _id: String(payment._id),
      amountCents: payment.amountCents,
      paidOn: payment.paidOn.toISOString(),
      note: payment.note ?? undefined,
      createdAt: payment.createdAt.toISOString(),
    })),
  };
}
