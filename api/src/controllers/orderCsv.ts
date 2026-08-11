import { toCsv } from '../utils/csv';
import { formatCents } from '../utils/money';
import { deriveStatus, isPaidLate, amountDueCents, type OrderStatus } from '../utils/status';

/**
 * Same presentation labels as web/components/StatusBadge.tsx — kept as a separate copy rather
 * than a shared import, since api/ and web/ are independently deployable apps with no shared
 * package. Status and paidLate are still derived from the one source of truth in utils/status.ts;
 * only the human-readable label lives twice.
 */
const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  overdue: 'Overdue',
};

const HEADERS = ['Customer', 'Due Date', 'Status', 'Paid Late', 'Total', 'Paid', 'Due', 'Created At'];

interface ExportableOrder {
  customer: string;
  dueDate: Date;
  totalCents: number;
  amountPaidCents: number;
  lastPaymentOn?: Date | null;
  createdAt: Date;
}

/** Separate Status/Paid Late columns rather than one combined string — a spreadsheet filter on
 *  "Overdue" shouldn't have to also match rows spelled "Overdue (late)". */
export function toOrdersCsv(orders: ExportableOrder[]): string {
  const rows = orders.map((order) => {
    const status = deriveStatus({
      amountPaidCents: order.amountPaidCents,
      totalCents: order.totalCents,
      dueDate: order.dueDate,
    });
    const late = isPaidLate(order.lastPaymentOn, order.dueDate, order.amountPaidCents, order.totalCents);

    return [
      order.customer,
      order.dueDate.toISOString().slice(0, 10),
      STATUS_LABELS[status],
      late ? 'Yes' : 'No',
      formatCents(order.totalCents),
      formatCents(order.amountPaidCents),
      formatCents(amountDueCents(order.amountPaidCents, order.totalCents)),
      order.createdAt.toISOString().slice(0, 10),
    ];
  });

  return toCsv(HEADERS, rows);
}
