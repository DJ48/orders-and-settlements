'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { formatCentsAsCurrency, parseDollarsToCents } from '@/lib/money';
import { StatusBadge } from '@/components/StatusBadge';
import { DatePicker } from '@/components/DatePicker';
import type { Order } from '@/lib/types';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function PaymentModal({
  order,
  onClose,
  onRecorded,
}: {
  order: Order;
  onClose: () => void;
  onRecorded: (updated: Order) => void;
}) {
  // Minted once, when the modal opens — not per keystroke or per submit attempt — so a retried
  // click after a network hiccup replays the same key instead of risking a double charge.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState(() => (order.amountDueCents / 100).toFixed(2));
  const [paidOn, setPaidOn] = useState(todayInputValue());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const amountCents = parseDollarsToCents(amount);
    if (amountCents === null || amountCents < 1) {
      setError('Amount should be greater than 0.');
      return;
    }
    if (amountCents > order.amountDueCents) {
      setError(`Amount can't be greater than Due Amount (${formatCentsAsCurrency(order.amountDueCents)}).`);
      return;
    }

    setSubmitting(true);
    try {
      const updated = await api.recordPayment(order._id, {
        amountCents,
        paidOn,
        note: note || undefined,
        idempotencyKey,
      });
      onRecorded(updated);
    } catch (err) {
      if (err instanceof ApiError) {
        // The API's actionable hint — surfaced directly rather than re-derived client-side,
        // so the server stays the one place that decides what "too much" means.
        const max = err.details?.maxAllowedCents;
        setError(typeof max === 'number' ? `${err.message} (max: ${formatCentsAsCurrency(max)})` : err.message);
      } else {
        setError('Could not record the payment.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-background p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-semibold">Record payment</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="amount" className="text-sm font-medium">
              Amount
            </label>
            <input
              id="amount"
              type="text"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-accent dark:border-white/20"
            />
            <p className="text-xs text-foreground/50">{formatCentsAsCurrency(order.amountDueCents)} due</p>
          </div>

          <div className="space-y-1">
            <label htmlFor="paidOn" className="text-sm font-medium">
              Date
            </label>
            <DatePicker id="paidOn" required value={paidOn} onChange={setPaidOn} />
          </div>

          <div className="space-y-1">
            <label htmlFor="note" className="text-sm font-medium">
              Note <span className="text-foreground/40">(optional)</span>
            </label>
            <input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-accent dark:border-white/20"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-black/15 px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-hover dark:border-white/20"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Recording…' : 'Record payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrder(await api.getOrder(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      // 404 covers both "doesn't exist" and "belongs to someone else" — the API deliberately
      // doesn't distinguish, so it never confirms which order IDs exist for other users.
      setError(err instanceof ApiError ? err.message : 'Could not load this order.');
    }
  }, [id, router]);

  useEffect(() => {
    // See the matching comment in dashboard/page.tsx — `load` synchronously clears `error`
    // before its first `await`, which the newer `set-state-in-effect` compiler-lint rule
    // flags even though it matches react.dev's own documented fetch-in-effect pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function handleDelete() {
    if (!order) return;
    if (!window.confirm(`Delete the order for ${order.customer}? This cannot be undone.`)) return;

    setDeleteError(null);
    setDeleting(true);
    try {
      await api.deleteOrder(order._id);
      router.push('/dashboard');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete this order.');
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 md:px-10">
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
        <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-accent underline underline-offset-4">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 md:px-10">
        <div className="animate-pulse space-y-3">
          <div className="h-8 w-64 rounded bg-surface" />
          <div className="h-40 rounded-xl bg-surface" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 md:px-10">
      <Link href="/dashboard" className="text-sm text-foreground/50 underline underline-offset-4 hover:text-foreground/70">
        ← Back to dashboard
      </Link>

      <div className="mt-4 mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{order.customer}</h1>
          <p className="mt-1 text-sm text-foreground/60">Due {formatDate(order.dueDate)}</p>
        </div>
        <StatusBadge status={order.status} paidLate={order.paidLate} />
      </div>

      <div className="mb-8 flex items-center gap-4">
        {order.canEditLineItems || order.canEditMetadata ? (
          <Link href={`/orders/${order._id}/edit`} className="text-sm font-medium text-accent underline underline-offset-4">
            Edit
          </Link>
        ) : (
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground/30">
            Edit
            <span
              tabIndex={0}
              title="This order can no longer be edited because it's been paid in full or gone overdue"
              aria-label="This order can no longer be edited because it's been paid in full or gone overdue"
              className="inline-flex cursor-help text-foreground/40"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
                <path d="M12 11v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="12" cy="8" r="1" fill="currentColor" />
              </svg>
            </span>
          </span>
        )}
        <button
          onClick={handleDelete}
          disabled={!order.canEditLineItems || deleting}
          title={!order.canEditLineItems ? 'Cannot delete an order with payments recorded against it' : undefined}
          className="text-sm font-medium text-danger underline underline-offset-4 disabled:cursor-not-allowed disabled:text-foreground/30 disabled:no-underline"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {deleteError && (
        <p role="alert" className="mb-6 text-sm text-danger">
          {deleteError}
        </p>
      )}

      <div className="mb-8 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border-subtle bg-surface px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Total</p>
          <p className="mt-1.5 text-xl font-semibold tabular-nums">{formatCentsAsCurrency(order.totalCents)}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Paid</p>
          <p className="mt-1.5 text-xl font-semibold tabular-nums text-success">{formatCentsAsCurrency(order.amountPaidCents)}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Due</p>
          <p className={`mt-1.5 text-xl font-semibold tabular-nums ${order.amountDueCents > 0 ? 'text-accent' : ''}`}>
            {formatCentsAsCurrency(order.amountDueCents)}
          </p>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-foreground/60">Line items</h2>
        <div className="overflow-hidden rounded-xl border border-border-subtle">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs uppercase tracking-wide text-foreground/50">
              <tr>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 font-medium">Qty</th>
                <th className="px-4 py-2 font-medium">Unit price</th>
                <th className="px-4 py-2 text-right font-medium">Item Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {order.lineItems.map((line) => (
                <tr key={line._id}>
                  <td className="px-4 py-2">{line.description}</td>
                  <td className="px-4 py-2">{line.quantity}</td>
                  <td className="px-4 py-2 tabular-nums">{formatCentsAsCurrency(line.unitPriceCents)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCentsAsCurrency(line.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground/60">Payment history</h2>
          <button
            onClick={() => setShowModal(true)}
            disabled={order.amountDueCents === 0}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-accent-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Record payment
          </button>
        </div>

        {order.payments.length === 0 ? (
          <p className="text-sm text-foreground/50">No payments recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
            {order.payments.map((payment) => (
              <li key={payment._id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{formatDate(payment.paidOn)}</p>
                  {payment.note && <p className="text-foreground/50">{payment.note}</p>}
                </div>
                <span className="tabular-nums font-medium text-success">{formatCentsAsCurrency(payment.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showModal && (
        <PaymentModal
          order={order}
          onClose={() => setShowModal(false)}
          onRecorded={(updated) => {
            // Only reflect the payment once the server has confirmed it — no optimistic update
            // on money, so what's on screen always matches what's actually been recorded.
            setOrder(updated);
            setShowModal(false);
          }}
        />
      )}
    </div>
  );
}
