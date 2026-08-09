/**
 * Money is an integer count of minor units (cents), everywhere. A float never touches a
 * monetary value.
 *
 * BSON has no NUMERIC type and `Double` is IEEE-754, so `$352.23 + $1492.14` would store as
 * 1844.3700000000001. Since `paid` is an equality test against the order total, that single
 * bit of error would leave the order permanently `partially_paid` AND reject its own final
 * payment as an over-payment.
 *
 * Conversion happens only at the API boundary — parseCents inbound, formatCents outbound.
 * Nothing in between deals in decimals.
 */

/** BSON Int32 ceiling: $21,474,836.47. Beyond this the driver would promote to Double. */
export const MAX_ORDER_CENTS = 2_147_483_647;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Up to 15 integer digits, optionally a decimal point and one or two digits.
 * Deliberately rejects exponent notation, thousands separators, and 3+ decimal places.
 */
const DECIMAL = /^-?\d{1,15}(\.\d{1,2})?$/;

/**
 * Parse a decimal amount into integer cents without going through floating point.
 *
 * `parseCents('10.99') === 1099`. `parseCents('1.005')` throws rather than guessing whether
 * the caller meant 1.00 or 1.01 — a money parser that rounds silently is worse than one that
 * refuses.
 */
export function parseCents(input: string | number): number {
  const raw = (typeof input === 'number' ? String(input) : input).trim();

  if (!DECIMAL.test(raw)) {
    throw new MoneyError(
      `"${input}" is not a valid amount — use up to two decimal places, e.g. "1250.00"`,
    );
  }

  const negative = raw.startsWith('-');
  const [whole = '0', fraction = ''] = raw.replace('-', '').split('.');

  // Pad before slicing so '0.5' reads as 50 cents, not 5.
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));

  return negative ? -cents : cents;
}

/** `formatCents(1099) === '10.99'`. No currency symbol — that's a presentation concern. */
export function formatCents(cents: number): string {
  assertInteger(cents, 'amount');

  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);

  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function assertInteger(cents: number, label = 'amount'): void {
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError(`${label} must be a whole number of cents, got ${cents}`);
  }
}

/**
 * Guard the Int32 ceiling explicitly.
 *
 * `quantity × unitPrice` can overflow before anything else complains, and a money field that
 * silently changes BSON type under load is a far worse outcome than a rejected order.
 */
export function assertWithinRange(cents: number, label = 'amount'): void {
  assertInteger(cents, label);

  if (cents > MAX_ORDER_CENTS) {
    throw new MoneyError(
      `${label} exceeds the maximum supported value of ${formatCents(MAX_ORDER_CENTS)}`,
    );
  }
}
