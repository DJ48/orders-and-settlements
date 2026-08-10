/**
 * Display-only formatting. The API is the source of truth for every computed monetary value
 * (totalCents, amountDueCents, ...) — this module never adds, subtracts, or compares money,
 * it only renders integer cents the server already computed.
 *
 * Parsing user input back into cents happens here too, for the same reason api/src/utils/money.ts
 * doesn't use parseFloat: '10.99' * 100 in floating point is not reliably 1099.
 */

const DECIMAL = /^\d{1,15}(\.\d{1,2})?$/;

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatCentsAsCurrency(cents: number): string {
  return `$${formatCents(cents)}`;
}

/** Returns null rather than throwing — form validation reads the null, not a caught exception. */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!DECIMAL.test(trimmed)) return null;

  const [whole, fraction = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}
