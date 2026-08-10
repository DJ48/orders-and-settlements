/**
 * Mirrors the API's response contract (see api/src/utils/status.ts and PLAN.md §4).
 *
 * Every order response carries its computed fields — status, amountDueCents, paidLate,
 * canEditLineItems — so the frontend never re-derives business rules. If a value here can be
 * computed from other fields, it should still come from the server: the API is the single
 * source of truth for what "paid" or "overdue" means.
 */

export type OrderStatus = 'pending' | 'partially_paid' | 'paid' | 'overdue';

export interface LineItem {
  _id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Payment {
  _id: string;
  amountCents: number;
  paidOn: string; // ISO date
  note?: string;
  createdAt: string;
}

export interface Order {
  _id: string;
  customer: string;
  dueDate: string; // ISO date
  lineItems: LineItem[];
  payments: Payment[];
  subtotalCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  status: OrderStatus;
  paidLate: boolean;
  canEditLineItems: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The dashboard list omits lineItems/payments — see the ESR-ordered index in PLAN.md §2. */
export type OrderSummary = Omit<Order, 'lineItems' | 'payments'>;

export interface User {
  _id: string;
  email: string;
  name?: string;
}

export interface LineItemInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CreateOrderInput {
  customer: string;
  dueDate: string;
  lineItems: LineItemInput[];
}

export interface RecordPaymentInput {
  amountCents: number;
  paidOn: string;
  note?: string;
  idempotencyKey: string;
}

/**
 * The API's error envelope (PLAN.md §4). `maxAllowedCents` is the actionable hint the brief
 * asks for — the payment form reads it directly rather than parsing the message string.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    field?: string;
    requestId?: string;
    details?: { maxAllowedCents?: number; [key: string]: unknown };
  };
}
