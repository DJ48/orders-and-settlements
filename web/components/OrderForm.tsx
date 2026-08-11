'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import { formatCentsAsCurrency, parseDollarsToCents } from '@/lib/money';
import { DatePicker } from '@/components/DatePicker';
import type { LineItem, LineItemInput } from '@/lib/types';

/**
 * Shared by the create and edit pages — both need identical dynamic line-item rows and a live
 * subtotal preview, and letting that logic drift between two copies is exactly the kind of
 * duplication this project has avoided everywhere else (see e.g. status derivation, the error
 * envelope). This component owns the form; the pages only own what happens on submit.
 */

export interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
}

const emptyLine = (): DraftLine => ({ description: '', quantity: '1', unitPrice: '' });

export function draftLinesFromLineItems(lineItems: LineItem[]): DraftLine[] {
  return lineItems.map((li) => ({
    description: li.description,
    quantity: String(li.quantity),
    unitPrice: (li.unitPriceCents / 100).toFixed(2),
  }));
}

/**
 * Recomputed client-side purely as a live preview — the server never trusts it.
 * computeTotals() in api/src/utils/totals.ts is the actual source of truth and re-derives this
 * from the submitted line items, so a manipulated client value has no effect.
 */
function computePreviewCents(lines: DraftLine[]): number | null {
  let total = 0;
  for (const line of lines) {
    const lineTotal = computeLineTotalCents(line);
    if (lineTotal === null) return null;
    total += lineTotal;
  }
  return total;
}

/** Per-row total shown next to each line — same math as computePreviewCents, one line at a time. */
function computeLineTotalCents(line: DraftLine): number | null {
  const qty = Number(line.quantity);
  const priceCents = parseDollarsToCents(line.unitPrice || '0');
  if (!Number.isInteger(qty) || qty < 1 || priceCents === null) return null;
  return qty * priceCents;
}

export interface OrderFormSubmitData {
  customer: string;
  dueDate: string;
  lineItems?: LineItemInput[];
}

interface OrderFormProps {
  initialCustomer?: string;
  initialDueDate?: string;
  initialLines?: DraftLine[];
  /** True once any payment exists — the server rejects a line-item change once money has been
   *  collected against this specific total, regardless of how much or whether it's overdue. */
  lineItemsLocked?: boolean;
  /** Narrower than lineItemsLocked: false only once the order is fully paid or overdue, since
   *  those are the only states where a customer/dueDate edit could rewrite something already
   *  true (a settled order's paidLate flag, or an overdue order's overdue-ness). A partially
   *  paid order that's still on track has nothing at risk yet, so it stays editable. */
  metadataLocked?: boolean;
  submitLabel: string;
  submittingLabel: string;
  onSubmit: (data: OrderFormSubmitData) => Promise<void>;
}

export function OrderForm({
  initialCustomer = '',
  initialDueDate = '',
  initialLines,
  lineItemsLocked = false,
  metadataLocked = false,
  submitLabel,
  submittingLabel,
  onSubmit,
}: OrderFormProps) {
  const [customer, setCustomer] = useState(initialCustomer);
  const [dueDate, setDueDate] = useState(initialDueDate);
  const [lines, setLines] = useState<DraftLine[]>(
    initialLines && initialLines.length > 0 ? initialLines : [emptyLine()],
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Every field locked at once — nothing on this page could be submitted successfully.
  const nothingEditable = lineItemsLocked && metadataLocked;

  const previewCents = useMemo(
    () => (lineItemsLocked ? null : computePreviewCents(lines)),
    [lines, lineItemsLocked],
  );

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

    // Omitted entirely when locked, rather than sent and rejected — the server would 409 an
    // attempted line-item change anyway, but there's nothing to change here in the first place.
    const lineItems: LineItemInput[] | undefined = lineItemsLocked
      ? undefined
      : lines.map((l) => {
          const unitPriceCents = parseDollarsToCents(l.unitPrice || '0');
          return { description: l.description, quantity: Number(l.quantity), unitPriceCents: unitPriceCents ?? -1 };
        });

    setSubmitting(true);
    try {
      await onSubmit({ customer, dueDate, lineItems });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {nothingEditable && (
        <p className="rounded-lg border border-black/10 bg-black/5 px-3 py-2 text-sm text-black/60 dark:border-white/10 dark:bg-white/5 dark:text-white/60">
          This order is locked because it's been paid in full or gone overdue — nothing below can be edited.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="customer" className="text-sm font-medium">
            Customer
          </label>
          <input
            id="customer"
            required
            disabled={metadataLocked}
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/20"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="dueDate" className="text-sm font-medium">
            Due date
          </label>
          <DatePicker id="dueDate" required disabled={metadataLocked} value={dueDate} onChange={setDueDate} />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Line items</h2>
          {!lineItemsLocked && (
            <button type="button" onClick={addLine} className="text-sm underline underline-offset-4">
              + Add Line Item
            </button>
          )}
        </div>

        {lineItemsLocked ? (
          <div className="space-y-2">
            {!nothingEditable && (
              <p className="text-xs text-black/50 dark:text-white/50">
                Line items are locked because a payment has been recorded against this order.
              </p>
            )}
            <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
              <table className="w-full text-sm">
                <thead className="bg-black/5 text-left text-xs uppercase tracking-wide text-black/50 dark:bg-white/5 dark:text-white/50">
                  <tr>
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Qty</th>
                    <th className="px-4 py-2 font-medium">Unit price</th>
                    <th className="px-4 py-2 font-medium">Item Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10 dark:divide-white/10">
                  {lines.map((line, i) => {
                    const lineTotalCents = computeLineTotalCents(line);
                    return (
                      <tr key={i}>
                        <td className="px-4 py-2">{line.description}</td>
                        <td className="px-4 py-2">{line.quantity}</td>
                        <td className="px-4 py-2">${line.unitPrice}</td>
                        <td className="px-4 py-2 tabular-nums">
                          {lineTotalCents === null ? '—' : formatCentsAsCurrency(lineTotalCents)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_5rem_7rem_7rem_auto] gap-2 px-1 text-xs font-medium uppercase tracking-wide text-black/50 dark:text-white/50">
              <span>Description</span>
              <span>Qty</span>
              <span>Unit price</span>
              <span>Item Total</span>
              <span aria-hidden="true" />
            </div>
            {lines.map((line, i) => {
              const lineTotalCents = computeLineTotalCents(line);
              return (
                <div key={i} className="grid grid-cols-[1fr_5rem_7rem_7rem_auto] gap-2">
                  <input
                    placeholder="Description"
                    required
                    value={line.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                    className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-white/20"
                  />
                  <input
                    type="number"
                    min={1}
                    step={1}
                    placeholder="Qty"
                    required
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                    className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-white/20"
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Unit price"
                    required
                    value={line.unitPrice}
                    onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                    className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-white/20"
                  />
                  <div className="flex items-center px-3 text-sm tabular-nums text-black/70 dark:text-white/70">
                    {lineTotalCents === null ? '—' : formatCentsAsCurrency(lineTotalCents)}
                  </div>
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
              );
            })}
          </div>
        )}
      </div>

      {!lineItemsLocked && (
        <div className="flex items-center justify-between border-t border-black/10 pt-4 dark:border-white/10">
          <span className="text-sm font-medium">Subtotal</span>
          <span className="text-lg font-semibold tabular-nums">
            {previewCents === null ? '—' : formatCentsAsCurrency(previewCents)}
          </span>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={nothingEditable || submitting || (!lineItemsLocked && (previewCents === null || previewCents < 1))}
        title={nothingEditable ? "This order is locked because it's been paid in full or gone overdue" : undefined}
        className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? submittingLabel : submitLabel}
      </button>
    </form>
  );
}
