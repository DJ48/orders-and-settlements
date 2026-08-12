'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
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
 * Defaults to empty — no range means no filtering, the dashboard shows everything, same as
 * before this control existed. Filtering only kicks in once the user picks a complete, valid
 * range, so "download CSV" can never silently produce a header-only file: the same range that
 * drives the download also drives what's on screen, via `disabledReason` from the parent, which
 * is the only place that knows both the range's validity and the actual filtered count.
 *
 * The download itself is a plain same-origin <a href>, not a fetch: the response is a CSV file
 * (Content-Disposition: attachment), so the browser downloads it directly rather than the page
 * fetching and parsing it — no blob handling needed, and the session cookie rides along exactly
 * like it would for any other same-origin navigation.
 */
function ExportCsvControl({
  from,
  to,
  onFromChange,
  onToChange,
  disabledReason,
  exportUrl,
}: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  disabledReason: string | undefined;
  exportUrl: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label htmlFor="exportFrom" className="text-xs font-medium text-foreground/50">
          Export due date from
        </label>
        <DatePicker id="exportFrom" value={from} onChange={onFromChange} />
      </div>
      <div className="space-y-1">
        <label htmlFor="exportTo" className="text-xs font-medium text-foreground/50">
          to
        </label>
        <DatePicker id="exportTo" value={to} onChange={onToChange} min={from} />
      </div>
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
    </div>
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
        <ExportCsvControl
          from={exportFrom}
          to={exportTo}
          onFromChange={(value) => updateParams({ from: value }, true)}
          onToChange={(value) => updateParams({ to: value }, true)}
          disabledReason={exportDisabledReason}
          exportUrl={exportUrl}
        />
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
