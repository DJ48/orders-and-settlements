'use client';

import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { AppHeader } from '@/components/AppHeader';
import { OrderForm, type OrderFormSubmitData } from '@/components/OrderForm';

export default function NewOrderPage() {
  const router = useRouter();

  async function handleSubmit({ customer, dueDate, lineItems }: OrderFormSubmitData) {
    const order = await api.createOrder({ customer, dueDate, lineItems: lineItems ?? [] });
    router.push(`/orders/${order._id}`);
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <AppHeader />
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">New order</h1>
      <OrderForm submitLabel="Create order" submittingLabel="Creating…" onSubmit={handleSubmit} />
    </main>
  );
}
