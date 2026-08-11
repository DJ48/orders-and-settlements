'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { formatCentsAsCurrency } from '@/lib/money';
import { StatusBadge } from '@/components/StatusBadge';
import { DatePicker } from '@/components/DatePicker';
import type { OrderStatus, OrderSummary } from '@/lib/types';

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
 * Builds 'YYYY-MM-DD' from the LOCAL y/m/d, never via toISOString() — that goes through UTC,
 * which rolls the date back a day whenever the browser's timezone is ahead of UTC (local
 * midnight on the 1st is still "the 31st" in UTC). Same pitfall DatePicker.tsx's own doc
 * comment calls out for exactly this reason.
 */
function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Defaults to "this month so far" — a reasonable starting point, not a business rule — and
 * clamps "to" so a user can't pick a range the server would just reject with a 400. The
 * download itself is a plain same-origin <a href>, not a fetch: the response is a CSV file
 * (Content-Disposition: attachment), so the browser downloads it directly rather than the page
 * fetching and parsing it — no blob handling needed, and the session cookie rides along exactly
 * like it would for any other same-origin navigation.
 */
function ExportCsvControl() {
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(() => toDateInputValue(today));

  const isValidRange = from !== '' && to !== '' && from <= to;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label htmlFor="exportFrom" className="text-xs font-medium text-foreground/50">
          Export due date from
        </label>
        <DatePicker id="exportFrom" value={from} onChange={setFrom} />
      </div>
      <div className="space-y-1">
        <label htmlFor="exportTo" className="text-xs font-medium text-foreground/50">
          to
        </label>
        <DatePicker id="exportTo" value={to} onChange={setTo} min={from} />
      </div>
      {isValidRange ? (
        <a
          href={api.orderExportUrl(from, to)}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3.5 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v13M7 11l5 5 5-5M4 21h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Export CSV
        </a>
      ) : (
        <span
          title="Pick a valid date range to export"
          className="cursor-not-allowed rounded-lg border border-border-subtle bg-surface px-3.5 py-2 text-sm font-medium text-foreground/30"
        >
          Export CSV
        </span>
      )}
    </div>
  );
}

/**
 * The filter lives in the URL rather than component state, so a filtered dashboard view is
 * shareable and survives a refresh — mirroring how the API itself is designed to be filtered
 * (?status=) rather than filtered client-side after fetching everything. The stat cards are
 * deliberately computed from that same filtered set, not a separate unfiltered fetch — so
 * filtering to "Overdue" makes the summary above the table answer exactly the question being
 * asked, rather than showing unrelated totals.
 */
function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeFilter = (searchParams.get('status') as OrderStatus | null) ?? 'all';

  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.listOrders(activeFilter === 'all' ? undefined : activeFilter);
      setOrders(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not load orders.');
    }
  }, [activeFilter, router]);

  useEffect(() => {
    // The documented react.dev fetch-in-effect pattern (setState before an async call to show
    // a loading state) trips the newer `set-state-in-effect` compiler-lint rule with no
    // documented alternative for this exact case. Suppressed deliberately rather than
    // restructured, to avoid trading a working, browser-verified effect for an undocumented one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrders(null);
    load();
  }, [load]);

  const stats = useMemo(() => {
    if (!orders) return null;
    return {
      count: orders.length,
      totalValue: orders.reduce((sum, o) => sum + o.totalCents, 0),
      outstanding: orders.reduce((sum, o) => sum + o.amountDueCents, 0),
      overdue: orders.filter((o) => o.status === 'overdue').length,
    };
  }, [orders]);

  function setFilter(value: OrderStatus | 'all') {
    const params = new URLSearchParams(searchParams);
    if (value === 'all') params.delete('status');
    else params.set('status', value);
    router.push(`/dashboard${params.toString() ? `?${params}` : ''}`);
  }

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Orders</h1>
      <p className="mb-8 text-sm text-foreground/50">
        Every order you&apos;ve created, what&apos;s been paid, and what&apos;s still due.
      </p>

      {stats && stats.count > 0 && (
        <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Orders" value={String(stats.count)} />
          <StatCard label="Total value" value={formatCentsAsCurrency(stats.totalValue)} />
          <StatCard label="Outstanding" value={formatCentsAsCurrency(stats.outstanding)} tone="accent" />
          <StatCard label="Overdue" value={String(stats.overdue)} tone={stats.overdue > 0 ? 'danger' : undefined} />
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
        <ExportCsvControl />
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
            {activeFilter === 'all' ? 'No orders yet.' : `No ${activeFilter.replace('_', ' ')} orders.`}
          </p>
          {activeFilter === 'all' && (
            <Link href="/orders/new" className="mt-2 inline-block text-sm font-medium text-accent underline underline-offset-4">
              Create your first order
            </Link>
          )}
        </div>
      )}

      {orders && orders.length > 0 && (
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
