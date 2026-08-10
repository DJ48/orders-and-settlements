'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { formatCentsAsCurrency, parseDollarsToCents } from '@/lib/money';

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
}

const emptyLine = (): DraftLine => ({ description: '', quantity: '1', unitPrice: '' });

/**
 * The subtotal is recomputed client-side purely as a live preview — the server never trusts
 * it. computeTotals() in api/src/utils/totals.ts is the actual source of truth and re-derives
 * this from the submitted line items, so a manipulated client value has no effect.
 */
function computePreviewCents(lines: DraftLine[]): number | null {
  let total = 0;
  for (const line of lines) {
    const qty = Number(line.quantity);
    const priceCents = parseDollarsToCents(line.unitPrice || '0');
    if (!Number.isInteger(qty) || qty < 1 || priceCents === null) return null;
    total += qty * priceCents;
  }
  return total;
}

export default function NewOrderPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const previewCents = useMemo(() => computePreviewCents(lines), [lines]);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const lineItems = lines.map((l) => {
      const unitPriceCents = parseDollarsToCents(l.unitPrice || '0');
      return { description: l.description, quantity: Number(l.quantity), unitPriceCents: unitPriceCents ?? -1 };
    });

    setSubmitting(true);
    try {
      const order = await api.createOrder({ customer, dueDate, lineItems });
      router.push(`/orders/${order._id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the order.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">New order</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="customer" className="text-sm font-medium">
              Customer
            </label>
            <input
              id="customer"
              required
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground dark:border-white/20"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="dueDate" className="text-sm font-medium">
              Due date
            </label>
            <input
              id="dueDate"
              type="date"
              required
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground dark:border-white/20"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Line items</h2>
            <button
              type="button"
              onClick={addLine}
              className="text-sm underline underline-offset-4"
            >
              + Add line
            </button>
          </div>

          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[1fr_5rem_7rem_auto] gap-2">
                <input
                  placeholder="Description"
                  required
                  value={line.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                  className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground dark:border-white/20"
                />
                <input
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Qty"
                  required
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground dark:border-white/20"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Unit price"
                  required
                  value={line.unitPrice}
                  onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                  className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground dark:border-white/20"
                />
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  disabled={lines.length === 1}
                  className="rounded-md px-2 text-sm text-black/50 hover:text-red-600 disabled:opacity-30 dark:text-white/50"
                  aria-label="Remove line"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-black/10 pt-4 dark:border-white/10">
          <span className="text-sm font-medium">Subtotal</span>
          <span className="text-lg font-semibold tabular-nums">
            {previewCents === null ? '—' : formatCentsAsCurrency(previewCents)}
          </span>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || previewCents === null || previewCents < 1}
          className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create order'}
        </button>
      </form>
    </main>
  );
}
