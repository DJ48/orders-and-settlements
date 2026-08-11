'use client';

import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { OrderForm, type OrderFormSubmitData } from '@/components/OrderForm';

export default function NewOrderPage() {
  const router = useRouter();

  async function handleSubmit({ customer, dueDate, lineItems }: OrderFormSubmitData) {
    const order = await api.createOrder({ customer, dueDate, lineItems: lineItems ?? [] });
    router.push(`/orders/${order._id}`);
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 md:px-10">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">New order</h1>
      <p className="mb-6 text-sm text-foreground/50">Line items, due date, and customer — the total is computed for you.</p>
      <OrderForm submitLabel="Create order" submittingLabel="Creating…" onSubmit={handleSubmit} />
    </div>
  );
}
