/**
 * Order status is DERIVED, never stored.
 *
 * `overdue` depends on today's date, which changes with no write to the document — so a stored
 * status would go stale silently and need a nightly sweep to correct. Instead we persist
 * `settlementState`, which encodes only the money axis and therefore cannot go stale, and apply
 * the time axis at query time.
 *
 * The two vocabularies are deliberately different so nobody returns the stored field as the
 * API status by mistake.
 */

/** The API contract — exactly the four values in the brief. */
export type OrderStatus = 'pending' | 'partially_paid' | 'paid' | 'overdue';

/** Storage only. Never appears in an API response. */
export type SettlementState = 'unpaid' | 'partial' | 'settled';

export const ORDER_STATUSES = ['pending', 'partially_paid', 'paid', 'overdue'] as const;

/**
 * Due dates are date-only. Normalising to UTC midnight keeps status stable regardless of the
 * server's timezone, and means an order due *today* is not overdue until tomorrow.
 */
export function utcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function settlementStateFor(amountPaidCents: number, totalCents: number): SettlementState {
  if (amountPaidCents >= totalCents) return 'settled';
  if (amountPaidCents > 0) return 'partial';
  return 'unpaid';
}

export interface StatusInput {
  amountPaidCents: number;
  totalCents: number;
  dueDate: Date;
  now?: Date;
}

/**
 * Precedence, highest first: paid > overdue > partially_paid > pending.
 *
 * `overdue` overlaps the two unsettled states — an unpaid order past its due date is both
 * `pending` and `overdue`, and `overdue` wins because it's the actionable one. An order that
 * was overdue and is now fully paid resolves to `paid`: status is a pure function of current
 * state, so nothing lingers. Use `isPaidLate` to surface that it settled late.
 */
export function deriveStatus({
  amountPaidCents,
  totalCents,
  dueDate,
  now,
}: StatusInput): OrderStatus {
  if (amountPaidCents >= totalCents) return 'paid';

  const today = utcDateOnly(now ?? new Date());
  if (today.getTime() > utcDateOnly(dueDate).getTime()) return 'overdue';

  return amountPaidCents > 0 ? 'partially_paid' : 'pending';
}

/** True when the order is settled but the final payment landed after the due date. */
export function isPaidLate(
  lastPaymentOn: Date | null | undefined,
  dueDate: Date,
  amountPaidCents: number,
  totalCents: number,
): boolean {
  if (!lastPaymentOn || amountPaidCents < totalCents) return false;
  return utcDateOnly(lastPaymentOn).getTime() > utcDateOnly(dueDate).getTime();
}

export function amountDueCents(amountPaidCents: number, totalCents: number): number {
  return Math.max(0, totalCents - amountPaidCents);
}

/**
 * Translate an API status filter into an index-friendly query fragment.
 *
 * Lives here so the mapping between the stored field and the derived status exists in exactly
 * one place. Every branch is answerable by { userId, deletedAt, settlementState, dueDate } —
 * equality fields first, range last (ESR).
 */
export function statusFilter(status: OrderStatus, now: Date = new Date()): Record<string, unknown> {
  const today = utcDateOnly(now);

  switch (status) {
    case 'paid':
      return { settlementState: 'settled' };
    case 'overdue':
      return { settlementState: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: today } };
    case 'pending':
      return { settlementState: 'unpaid', dueDate: { $gte: today } };
    case 'partially_paid':
      return { settlementState: 'partial', dueDate: { $gte: today } };
  }
}
