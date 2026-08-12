'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { formatCentsAsCurrency } from '@/lib/money';
import { StatusBadge } from '@/components/StatusBadge';
import { DatePicker } from '@/components/DatePicker';
import type { OrderStatus, PagedOrders } from '@/lib/types';

const FILTERS: { label: string; value: OrderStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Partially paid', value: 'partially_paid' },
  { label: 'Paid', value: 'paid' },
  { label: 'Overdue', value: 'overdue' },
];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Builds 'YYYY-MM-DD' from the LOCAL y/m/d, never via toISOString() — that goes through UTC,
 * which rolls the date back a day whenever the browser's timezone is ahead of UTC (local
 * midnight on the 1st is still "the 31st" in UTC). Same pitfall DatePicker.tsx's own doc
 * comment calls out for exactly this reason.
 */
function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A short display label for a bare 'YYYY-MM-DD' value — parses the y/m/d directly rather than
 *  going through `new Date(string)` (which reads it as UTC and risks the same off-by-one-day
 *  shift as above once `.toLocaleDateString()` converts back to local time for display). */
function formatDateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 12); // noon avoids DST edge cases
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const DUE_DATE_PRESETS: { label: string; range: () => [string, string] }[] = [
  {
    label: 'Today',
    range: () => {
      const today = toDateInputValue(new Date());
      return [today, today];
    },
  },
  {
    label: 'Yesterday',
    range: () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const value = toDateInputValue(d);
      return [value, value];
    },
  },
  {
    label: 'This Month',
    range: () => {
      const d = new Date();
      return [toDateInputValue(new Date(d.getFullYear(), d.getMonth(), 1)), toDateInputValue(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
    },
  },
  {
    label: 'Past Month',
    range: () => {
      const d = new Date();
      return [toDateInputValue(new Date(d.getFullYear(), d.getMonth() - 1, 1)), toDateInputValue(new Date(d.getFullYear(), d.getMonth(), 0))];
    },
  },
  {
    label: 'Past 3 Months',
    range: () => {
      const d = new Date();
      return [toDateInputValue(new Date(d.getFullYear(), d.getMonth() - 3, d.getDate())), toDateInputValue(d)];
    },
  },
];

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'accent' }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">{label}</p>
      <p
        className={`mt-1.5 text-2xl font-semibold tabular-nums ${
          tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * A dropdown trigger ("Any Date" / the picked range) rather than two always-visible date
 * fields — opens a popover with From/To pickers, quick presets, and a Clear action. Picking
 * both ends of a range (in either order, via the fields or a preset) applies immediately and
 * closes the popover; there's no separate "Apply" step, matching how the rest of this app's
 * controls act on selection rather than needing confirmation.
 */
function DueDateFilterDropdown({
  from,
  to,
  onApplyRange,
  onClear,
}: {
  from: string;
  to: string;
  onApplyRange: (from: string, to: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  function openPopover() {
    setDraftFrom(from);
    setDraftTo(to);
    setOpen(true);
  }

  function pick(nextFrom: string, nextTo: string) {
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    if (nextFrom && nextTo) {
      onApplyRange(nextFrom, nextTo);
      setOpen(false);
    }
  }

  function clear() {
    setDraftFrom('');
    setDraftTo('');
    onClear();
    setOpen(false);
  }

  const hasFilter = from !== '' && to !== '';

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPopover())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
          hasFilter
            ? 'bg-accent text-accent-foreground'
            : 'border border-border-subtle bg-surface text-foreground/70 hover:bg-surface-hover'
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {hasFilter ? `${formatDateLabel(from)} – ${formatDateLabel(to)}` : 'Any Date'}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter by due date"
          className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-border-subtle bg-background p-4 shadow-lg"
        >
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="dueDateFrom" className="text-xs font-medium text-foreground/50">
                From
              </label>
              <DatePicker id="dueDateFrom" value={draftFrom} onChange={(value) => pick(value, draftTo)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="dueDateTo" className="text-xs font-medium text-foreground/50">
                To
              </label>
              <DatePicker id="dueDateTo" value={draftTo} onChange={(value) => pick(draftFrom, value)} min={draftFrom} />
            </div>
          </div>

          <div className="space-y-1.5">
            {DUE_DATE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  const [presetFrom, presetTo] = preset.range();
                  pick(presetFrom, presetTo);
                }}
                className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
              >
                {preset.label}
              </button>
            ))}
          </div>

          {hasFilter && (
            <button
              type="button"
              onClick={clear}
              className="mt-3 w-full rounded-lg px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-surface-hover"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The download itself is a plain same-origin <a href>, not a fetch: the response is a CSV file
 * (Content-Disposition: attachment), so the browser downloads it directly rather than the page
 * fetching and parsing it — no blob handling needed, and the session cookie rides along exactly
 * like it would for any other same-origin navigation.
 */
function ExportCsvButton({ disabledReason, exportUrl }: { disabledReason: string | undefined; exportUrl: string }) {
  return (
    <>
      {!disabledReason ? (
        <a
          href={exportUrl}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3.5 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v13M7 11l5 5 5-5M4 21h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Export CSV
        </a>
      ) : (
        <span
          title={disabledReason}
          className="cursor-not-allowed rounded-lg border border-border-subtle bg-surface px-3.5 py-2 text-sm font-medium text-foreground/30"
        >
          Export CSV
        </span>
      )}
    </>
  );
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  if (totalPages <= 1) return null;

  return (
    <div className="mt-4 flex items-center justify-between">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="rounded-lg border border-border-subtle px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-sm text-foreground/50">
        Page {page} of {totalPages}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="rounded-lg border border-border-subtle px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

/**
 * Every filter — status, date range, page — lives in the URL rather than component state, so a
 * filtered dashboard view is shareable and survives a refresh, mirroring how the API itself is
 * designed to be filtered server-side rather than filtered client-side after fetching everything.
 * The stat cards come from the API's `summary`, aggregated over every order matching the current
 * filter — not just the current page — so filtering to "Overdue" (or paging to page 3) never
 * changes what the summary above the table is answering.
 */
function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeFilter = (searchParams.get('status') as OrderStatus | null) ?? 'all';
  const exportFrom = searchParams.get('from') ?? '';
  const exportTo = searchParams.get('to') ?? '';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  const [result, setResult] = useState<PagedOrders | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bothDatesEmpty = exportFrom === '' && exportTo === '';
  const validExportRange = exportFrom !== '' && exportTo !== '' && exportFrom <= exportTo;
  // Exactly one filled, or from > to — a range that's been started but isn't usable yet. Falls
  // back to no date filter (like the empty default) rather than sending the server a range it
  // would just reject with a 400.
  const partialOrInvalidExportRange = !bothDatesEmpty && !validExportRange;

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.listOrders({
        status: activeFilter === 'all' ? undefined : activeFilter,
        from: validExportRange ? exportFrom : undefined,
        to: validExportRange ? exportTo : undefined,
        page,
      });
      setResult(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not load orders.');
    }
  }, [activeFilter, exportFrom, exportTo, validExportRange, page, router]);

  useEffect(() => {
    // The documented react.dev fetch-in-effect pattern (setState before an async call to show
    // a loading state) trips the newer `set-state-in-effect` compiler-lint rule with no
    // documented alternative for this exact case. Suppressed deliberately rather than
    // restructured, to avoid trading a working, browser-verified effect for an undocumented one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult(null);
    load();
  }, [load]);

  function updateParams(patch: Record<string, string | undefined>, resetPage: boolean) {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') params.delete(key);
      else params.set(key, value);
    }
    if (resetPage) params.delete('page');
    router.push(`/dashboard${params.toString() ? `?${params}` : ''}`);
  }

  useEffect(() => {
    // Filtering down (or the page just loading) can leave `page` pointing past the end — snap
    // back to the last real page rather than showing a confusing "empty" table that isn't.
    if (result && result.total > 0 && page > result.totalPages) {
      updateParams({ page: String(result.totalPages) }, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, page]);

  function setFilter(value: OrderStatus | 'all') {
    updateParams({ status: value === 'all' ? undefined : value }, true);
  }

  // Single source of truth for whether the export link is live — the button, the table, and the
  // download must always agree on what "nothing to export" means.
  const exportDisabledReason = partialOrInvalidExportRange
    ? 'Pick a valid date range to export'
    : result === null || result.total === 0
      ? validExportRange
        ? 'No orders due in this range'
        : 'No orders to export'
      : undefined;

  const exportUrl = api.orderExportUrl({
    status: activeFilter === 'all' ? undefined : activeFilter,
    from: validExportRange ? exportFrom : undefined,
    to: validExportRange ? exportTo : undefined,
  });

  const orders = result?.orders ?? null;

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Orders</h1>
      <p className="mb-8 text-sm text-foreground/50">
        Every order you&apos;ve created, what&apos;s been paid, and what&apos;s still due.
      </p>

      {result && result.total > 0 && (
        <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Orders" value={String(result.total)} />
          <StatCard label="Total value" value={formatCentsAsCurrency(result.summary.totalValueCents)} />
          <StatCard label="Outstanding" value={formatCentsAsCurrency(result.summary.outstandingCents)} tone="accent" />
          <StatCard
            label="Overdue"
            value={String(result.summary.overdueCount)}
            tone={result.summary.overdueCount > 0 ? 'danger' : undefined}
          />
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                activeFilter === f.value
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-surface text-foreground/70 hover:bg-surface-hover'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DueDateFilterDropdown
            from={exportFrom}
            to={exportTo}
            onApplyRange={(from, to) => updateParams({ from, to }, true)}
            onClear={() => updateParams({ from: undefined, to: undefined }, true)}
          />
          <ExportCsvButton disabledReason={exportDisabledReason} exportUrl={exportUrl} />
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      {orders === null && !error && (
        <div className="animate-pulse space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-lg bg-surface" />
          ))}
        </div>
      )}

      {orders?.length === 0 && (
        <div className="rounded-xl border border-dashed border-border-subtle px-6 py-16 text-center">
          <p className="text-sm text-foreground/60">
            {validExportRange
              ? `No orders due between ${exportFrom} and ${exportTo}.`
              : activeFilter === 'all'
                ? 'No orders yet.'
                : `No ${activeFilter.replace('_', ' ')} orders.`}
          </p>
          {activeFilter === 'all' && !validExportRange && (
            <Link href="/orders/new" className="mt-2 inline-block text-sm font-medium text-accent underline underline-offset-4">
              Create your first order
            </Link>
          )}
        </div>
      )}

      {orders && orders.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-xl border border-border-subtle">
            <table className="w-full text-sm">
              <thead className="bg-surface text-left text-xs uppercase tracking-wide text-foreground/50">
                <tr>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Total</th>
                  <th className="px-4 py-3 font-medium">Paid</th>
                  <th className="px-4 py-3 font-medium">Due</th>
                  <th className="px-4 py-3 font-medium">Due date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {orders.map((order) => (
                  <tr
                    key={order._id}
                    onClick={() => router.push(`/orders/${order._id}`)}
                    className="cursor-pointer transition-colors hover:bg-surface"
                  >
                    <td className="px-4 py-3 font-medium">{order.customer}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={order.status} paidLate={order.paidLate} />
                    </td>
                    <td className="px-4 py-3 tabular-nums">{formatCentsAsCurrency(order.totalCents)}</td>
                    <td className="px-4 py-3 tabular-nums">{formatCentsAsCurrency(order.amountPaidCents)}</td>
                    <td className="px-4 py-3 tabular-nums">{formatCentsAsCurrency(order.amountDueCents)}</td>
                    <td className="px-4 py-3">{formatDate(order.dueDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result && <Pagination page={result.page} totalPages={result.totalPages} onPageChange={(p) => updateParams({ page: String(p) }, false)} />}
        </>
      )}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10">Loading…</div>}>
      <DashboardContent />
    </Suspense>
  );
}
