'use client';

import { formatCentsAsCurrency } from '@/lib/money';
import type { AuditEntry, AuditAction } from '@/lib/types';

/**
 * The order's audit trail, newest first.
 *
 * Every label and amount here is read from the server's entry — nothing is re-derived. The point
 * of an audit trail is that it says what actually happened, so a client that recomputed the story
 * from the order's current state would defeat it.
 */

const LABELS: Record<AuditAction, string> = {
  'order.created': 'Order created',
  'order.updated': 'Order updated',
  'order.deleted': 'Order deleted',
  'payment.recorded': 'Payment recorded',
  'payment.rejected': 'Payment refused',
};

/** Refusals are the one entry that isn't neutral bookkeeping, so they're the one that's coloured. */
const DOT: Record<AuditAction, string> = {
  'order.created': 'bg-foreground/25',
  'order.updated': 'bg-foreground/25',
  'order.deleted': 'bg-danger',
  'payment.recorded': 'bg-success',
  'payment.rejected': 'bg-danger',
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

function centsFrom(source: Record<string, unknown> | undefined, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' ? value : null;
}

/** The one-line "what changed", built per action from `delta`. Null means the label says it all. */
function describe(entry: AuditEntry): string | null {
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
      {entries.map((entry) => {
        const detail = describe(entry);
        // Suppressed on creation only: "paid to date: $0.00" is true by definition there. It stays
        // on every other action, including a refusal, where "nothing changed" is the useful part.
        const paid = entry.action === 'order.created' ? undefined : entry.snapshot?.amountPaidCents;

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
            {detail && <p className="mt-0.5 text-sm tabular-nums text-foreground/60">{detail}</p>}
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
