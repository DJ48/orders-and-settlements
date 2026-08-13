'use client';

import { formatCentsAsCurrency } from '@/lib/money';
import type { AuditEntry, AuditAction, OrderStatus } from '@/lib/types';

/**
 * The order's audit trail, newest first.
 *
 * Every label, amount and status here is read from the server's entry — nothing is re-derived.
 * The point of an audit trail is that it says what actually happened, so a client that
 * reconstructed the story from the order's current state would defeat it.
 */

const LABELS: Record<AuditAction, string> = {
  'order.created': 'Order created',
  'order.updated': 'Order updated',
  'order.deleted': 'Order deleted',
  'payment.recorded': 'Payment recorded',
  'payment.rejected': 'Payment refused',
};

/** Refusals and deletions are the entries that aren't neutral bookkeeping, so they're coloured. */
const DOT: Record<AuditAction, string> = {
  'order.created': 'bg-foreground/25',
  'order.updated': 'bg-foreground/25',
  'order.deleted': 'bg-danger',
  'payment.recorded': 'bg-success',
  'payment.rejected': 'bg-danger',
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  overdue: 'Overdue',
};

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function centsFrom(source: Record<string, unknown> | undefined, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' ? value : null;
}

interface FieldChange {
  from: unknown;
  to: unknown;
}

function changesOf(entry: AuditEntry): Record<string, FieldChange> {
  const raw = entry.delta?.changes;
  return raw && typeof raw === 'object' ? (raw as Record<string, FieldChange>) : {};
}

/** `{ count, totalCents }` on either side of a line-item edit. */
function lineItemSide(value: unknown): { count: number; totalCents: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { count, totalCents } = value as { count?: unknown; totalCents?: unknown };
  return typeof count === 'number' && typeof totalCents === 'number' ? { count, totalCents } : null;
}

/**
 * One line per field that moved. Line items are summarised as a count and a total rather than
 * itemised: the interesting fact is that the amount owed changed and by how much, not which row
 * was retyped — and an order's items can only change while it has no payments at all.
 */
function describeChanges(entry: AuditEntry): string[] {
  const changes = changesOf(entry);
  const lines: string[] = [];

  const customer = changes.customer;
  if (customer) lines.push(`Customer: ${String(customer.from)} → ${String(customer.to)}`);

  const dueDate = changes.dueDate;
  if (dueDate) lines.push(`Due date: ${formatDay(String(dueDate.from))} → ${formatDay(String(dueDate.to))}`);

  const items = changes.lineItems;
  if (items) {
    const from = lineItemSide(items.from);
    const to = lineItemSide(items.to);
    if (from && to) {
      const delta = to.count - from.count;
      const verb = delta > 0 ? `${delta} item${delta === 1 ? '' : 's'} added` : delta < 0 ? `${-delta} item${delta === -1 ? '' : 's'} removed` : 'Items edited';
      lines.push(`${verb} — total ${formatCentsAsCurrency(from.totalCents)} → ${formatCentsAsCurrency(to.totalCents)}`);
    } else {
      lines.push('Line items edited');
    }
  }

  return lines;
}

/** The one-line "what happened" for money events. Null means the label already says it. */
function describeMoney(entry: AuditEntry): string | null {
  if (entry.action === 'payment.recorded') {
    const amount = centsFrom(entry.delta, 'amountCents');
    return amount === null ? null : formatCentsAsCurrency(amount);
  }

  if (entry.action === 'payment.rejected') {
    const attempted = centsFrom(entry.delta, 'attemptedCents');
    const max = centsFrom(entry.delta, 'maxAllowedCents');
    if (attempted === null) return null;
    return max === null
      ? `${formatCentsAsCurrency(attempted)} attempted`
      : `${formatCentsAsCurrency(attempted)} attempted — ${formatCentsAsCurrency(max)} was the most allowed`;
  }

  return null;
}

export function OrderTimeline({ entries, error }: { entries: AuditEntry[] | null; error?: string | null }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }

  if (entries === null) {
    return <div className="h-20 animate-pulse rounded-xl bg-surface" />;
  }

  if (entries.length === 0) {
    return <p className="text-sm text-foreground/50">Nothing recorded yet.</p>;
  }

  return (
    <ol className="relative space-y-4 border-l border-border-subtle pl-5">
      {entries.map((entry, i) => {
        const money = describeMoney(entry);
        const changes = describeChanges(entry);
        // A running balance belongs on money events only. On a creation it's $0.00 by definition,
        // and on an edit it's an unrelated number sitting under a customer-name change. Kept on a
        // refusal, where "the balance did not move" is precisely the useful part.
        const isMoneyEvent = entry.action === 'payment.recorded' || entry.action === 'payment.rejected';
        const paid = isMoneyEvent ? entry.snapshot?.amountPaidCents : undefined;
        // Entries are newest-first, so the older neighbour is the NEXT one in the array.
        const previousStatus = entries[i + 1]?.status;
        const statusMoved = entry.status && previousStatus && entry.status !== previousStatus;

        return (
          <li key={entry._id} className="relative">
            <span
              aria-hidden="true"
              className={`absolute -left-[1.6rem] top-1.5 h-2 w-2 rounded-full ring-4 ring-background ${DOT[entry.action]}`}
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <p className="text-sm font-medium">{LABELS[entry.action]}</p>
              <time dateTime={entry.at} className="text-xs tabular-nums text-foreground/45">
                {formatTimestamp(entry.at)}
              </time>
            </div>

            {money && <p className="mt-0.5 text-sm tabular-nums text-foreground/60">{money}</p>}

            {changes.map((line) => (
              <p key={line} className="mt-0.5 text-sm text-foreground/60">
                {line}
              </p>
            ))}

            {statusMoved && (
              <p className="mt-0.5 text-xs text-foreground/45">
                Status: {STATUS_LABELS[previousStatus]} → {STATUS_LABELS[entry.status!]}
              </p>
            )}

            {typeof paid === 'number' && (
              <p className="mt-0.5 text-xs tabular-nums text-foreground/40">
                Paid to date: {formatCentsAsCurrency(paid)}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
