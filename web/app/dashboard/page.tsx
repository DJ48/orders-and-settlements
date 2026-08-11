'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { formatCentsAsCurrency } from '@/lib/money';
import { StatusBadge } from '@/components/StatusBadge';
import { AppHeader } from '@/components/AppHeader';
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

/**
 * The filter lives in the URL rather than component state, so a filtered dashboard view is
 * shareable and survives a refresh — mirroring how the API itself is designed to be filtered
 * (?status=) rather than filtered client-side after fetching everything.
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

  function setFilter(value: OrderStatus | 'all') {
    const params = new URLSearchParams(searchParams);
    if (value === 'all') params.delete('status');
    else params.set('status', value);
    router.push(`/dashboard${params.toString() ? `?${params}` : ''}`);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <AppHeader>
        <Link
          href="/orders/new"
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          New order
        </Link>
      </AppHeader>

      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Orders</h1>

      <div className="mb-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              activeFilter === f.value
                ? 'bg-foreground text-background'
                : 'bg-black/5 text-black/70 hover:bg-black/10 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/15'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {orders === null && !error && (
        <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
      )}

      {orders?.length === 0 && (
        <div className="rounded-lg border border-dashed border-black/15 px-6 py-12 text-center dark:border-white/20">
          <p className="text-sm text-black/60 dark:text-white/60">
            {activeFilter === 'all' ? 'No orders yet.' : `No ${activeFilter.replace('_', ' ')} orders.`}
          </p>
          {activeFilter === 'all' && (
            <Link href="/orders/new" className="mt-2 inline-block text-sm underline underline-offset-4">
              Create your first order
            </Link>
          )}
        </div>
      )}

      {orders && orders.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-black/5 text-left text-xs uppercase tracking-wide text-black/50 dark:bg-white/5 dark:text-white/50">
              <tr>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Paid</th>
                <th className="px-4 py-3 font-medium">Due</th>
                <th className="px-4 py-3 font-medium">Due date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10 dark:divide-white/10">
              {orders.map((order) => (
                <tr
                  key={order._id}
                  onClick={() => router.push(`/orders/${order._id}`)}
                  className="cursor-pointer transition-colors hover:bg-black/5 dark:hover:bg-white/5"
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
    </main>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-5xl px-6 py-10">Loading…</main>}>
      <DashboardContent />
    </Suspense>
  );
}
