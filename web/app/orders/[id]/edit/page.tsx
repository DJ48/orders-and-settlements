'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { AppHeader } from '@/components/AppHeader';
import { OrderForm, draftLinesFromLineItems, type OrderFormSubmitData } from '@/components/OrderForm';
import type { Order } from '@/lib/types';

export default function EditOrderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrder(await api.getOrder(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      // Covers both "doesn't exist" and "belongs to someone else" — the API deliberately
      // doesn't distinguish, so the page shouldn't either.
      setError(err instanceof ApiError ? err.message : 'Could not load this order.');
    }
  }, [id, router]);

  useEffect(() => {
    // `load` synchronously clears `error` before its first `await`, which the newer
    // `set-state-in-effect` compiler-lint rule flags even though it matches react.dev's own
    // documented fetch-in-effect pattern. See the matching comment in dashboard/page.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function handleSubmit({ customer, dueDate, lineItems }: OrderFormSubmitData) {
    await api.updateOrder(id, { customer, dueDate, lineItems });
    router.push(`/orders/${id}`);
  }

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <AppHeader />
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
        <Link href="/dashboard" className="mt-4 inline-block text-sm underline underline-offset-4">
          Back to dashboard
        </Link>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <AppHeader />
        <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <AppHeader />
      <Link
        href={`/orders/${id}`}
        className="text-sm text-black/50 underline underline-offset-4 dark:text-white/50"
      >
        ← Back to order
      </Link>
      <h1 className="mt-4 mb-6 text-2xl font-semibold tracking-tight">Edit order</h1>
      <OrderForm
        initialCustomer={order.customer}
        initialDueDate={order.dueDate.slice(0, 10)}
        initialLines={draftLinesFromLineItems(order.lineItems)}
        lineItemsLocked={!order.canEditLineItems}
        submitLabel="Save changes"
        submittingLabel="Saving…"
        onSubmit={handleSubmit}
      />
    </main>
  );
}
