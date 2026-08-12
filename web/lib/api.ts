import type {
  Order,
  PagedOrders,
  OrderStatus,
  CreateOrderInput,
  UpdateOrderInput,
  RecordPaymentInput,
  User,
  ApiErrorBody,
} from './types';

/**
 * The API and the frontend are separately deployed (api/ on Render, web/ on Vercel), but the
 * browser only ever talks to THIS origin — next.config.ts proxies /api/* to the Express API
 * server-side. That's deliberate: a genuinely cross-origin cookie is a third-party cookie, and
 * Safari/Brave block those by default (Chrome/Edge do too in private mode). Routing through a
 * same-origin proxy makes the session cookie an ordinary first-party cookie instead.
 *
 * `credentials: 'include'` is still needed — same-origin doesn't imply cookies are sent by
 * default on every fetch, only that the browser is willing to store and send them at all here.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly field?: string,
    public readonly details?: ApiErrorBody['error']['details'],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });

  if (!res.ok) {
    // The backend isn't guaranteed to return the JSON envelope for every failure mode
    // (a proxy 502, for instance), so this must not throw on a non-JSON body.
    const body: ApiErrorBody | null = await res.json().catch(() => null);
    throw new ApiError(
      body?.error.message ?? res.statusText,
      body?.error.code ?? 'UNKNOWN_ERROR',
      res.status,
      body?.error.field,
      body?.error.details,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  signup: (email: string, password: string, name?: string) =>
    request<User>('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, name }) }),

  login: (email: string, password: string) =>
    request<User>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  me: () => request<User>('/auth/me'),

  listOrders: (options: { status?: OrderStatus; from?: string; to?: string; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    if (options.page) params.set('page', String(options.page));
    if (options.pageSize) params.set('pageSize', String(options.pageSize));
    const query = params.toString();
    return request<PagedOrders>(`/orders${query ? `?${query}` : ''}`);
  },

  getOrder: (id: string) => request<Order>(`/orders/${id}`),

  createOrder: (input: CreateOrderInput) =>
    request<Order>('/orders', { method: 'POST', body: JSON.stringify(input) }),

  updateOrder: (id: string, input: UpdateOrderInput) =>
    request<Order>(`/orders/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  deleteOrder: (id: string) => request<void>(`/orders/${id}`, { method: 'DELETE' }),

  recordPayment: (orderId: string, input: RecordPaymentInput) =>
    request<Order>(`/orders/${orderId}/payments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Not routed through request() — the response is a CSV file, not JSON, and the browser
  // downloads it directly (Content-Disposition: attachment) rather than the page fetching and
  // parsing it. A plain same-origin URL for an <a href> to point at. All params optional —
  // omitting them exports every order, matching the API's own contract. `status` is included so
  // the export always matches whatever the dashboard's status filter is currently showing.
  orderExportUrl: (options: { status?: OrderStatus; from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    const query = params.toString();
    return `/api/v1/orders/export${query ? `?${query}` : ''}`;
  },
};
