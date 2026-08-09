import { MoneyError, assertInteger, assertWithinRange } from './money';

/**
 * Arrays in a MongoDB document should be bounded by policy rather than by luck. 200 is far
 * above any realistic B2B order and far below the 16MB document ceiling.
 */
export const MAX_LINE_ITEMS = 200;

export interface LineItemInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface ComputedLineItem extends LineItemInput {
  lineTotalCents: number;
}

export interface OrderTotals {
  lineItems: ComputedLineItem[];
  subtotalCents: number;
  totalCents: number;
}

/**
 * Compute line totals and the order total from line items.
 *
 * Always server-side — a client-supplied total is never trusted. `lineTotalCents` is then
 * persisted rather than recomputed on read, so each line stays an immutable historical record
 * even if pricing or rounding rules change later.
 */
export function computeTotals(lines: LineItemInput[]): OrderTotals {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new MoneyError('An order needs at least one line item');
  }

  if (lines.length > MAX_LINE_ITEMS) {
    throw new MoneyError(
      `An order cannot have more than ${MAX_LINE_ITEMS} line items (got ${lines.length})`,
    );
  }

  const lineItems: ComputedLineItem[] = lines.map((line, index) => {
    const label = `line ${index + 1}`;

    assertInteger(line.quantity, `${label} quantity`);
    if (line.quantity < 1) {
      throw new MoneyError(`${label} quantity must be at least 1`);
    }

    assertWithinRange(line.unitPriceCents, `${label} unit price`);
    if (line.unitPriceCents < 0) {
      throw new MoneyError(`${label} unit price cannot be negative`);
    }

    const lineTotalCents = line.quantity * line.unitPriceCents;
    assertWithinRange(lineTotalCents, `${label} total`);

    return { ...line, lineTotalCents };
  });

  const subtotalCents = lineItems.reduce((sum, line) => sum + line.lineTotalCents, 0);
  assertWithinRange(subtotalCents, 'order subtotal');

  // Total equals subtotal today. Kept as a distinct field because this is exactly where
  // order-level tax and discounts would apply — the brief calls them out as not required,
  // which is a statement about scope rather than about the shape of an order.
  const totalCents = subtotalCents;

  if (totalCents < 1) {
    throw new MoneyError(
      'Order total must be greater than zero — a zero-total order would count as fully paid the moment it was created',
    );
  }

  return { lineItems, subtotalCents, totalCents };
}
