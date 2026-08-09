import { describe, it, expect } from 'vitest';
import { computeTotals, MAX_LINE_ITEMS } from '../../src/utils/totals';
import { MoneyError, MAX_ORDER_CENTS } from '../../src/utils/money';

const line = (quantity: number, unitPriceCents: number, description = 'Widget') => ({
  description,
  quantity,
  unitPriceCents,
});

describe('computeTotals', () => {
  it("handles the brief's sample order: 2 Ã— $500 = $1,000", () => {
    const totals = computeTotals([line(2, 50_000)]);

    expect(totals.lineItems[0]?.lineTotalCents).toBe(100_000);
    expect(totals.subtotalCents).toBe(100_000);
    expect(totals.totalCents).toBe(100_000);
  });

  it('sums across multiple lines', () => {
    const totals = computeTotals([line(3, 1999), line(1, 500), line(10, 25)]);
    expect(totals.subtotalCents).toBe(3 * 1999 + 500 + 10 * 25);
  });

  it('is exact on values that break float multiplication', () => {
    expect(computeTotals([line(11, 115)]).totalCents).toBe(1265); // 11 Ã— 1.15
    expect(computeTotals([line(3, 10)]).totalCents).toBe(30); //     3 Ã— 0.10
  });

  it('allows zero-priced lines while the order total stays positive', () => {
    expect(computeTotals([line(1, 50_000), line(1, 0, 'Free shipping')]).totalCents).toBe(50_000);
  });

  it('persists lineTotalCents rather than leaving it derived', () => {
    expect(computeTotals([line(4, 250)]).lineItems[0]).toMatchObject({
      quantity: 4,
      unitPriceCents: 250,
      lineTotalCents: 1000,
    });
  });

  describe('rejects', () => {
    it('an order with no lines', () => {
      expect(() => computeTotals([])).toThrow(MoneyError);
    });

    it('quantity below 1', () => {
      expect(() => computeTotals([line(0, 500)])).toThrow(/quantity must be at least 1/);
    });

    it('fractional quantity', () => {
      expect(() => computeTotals([line(1.5, 500)])).toThrow(MoneyError);
    });

    it('negative unit price', () => {
      expect(() => computeTotals([line(1, -500)])).toThrow(MoneyError);
    });

    it('a zero total â€” it would count as fully paid on creation', () => {
      expect(() => computeTotals([line(1, 0)])).toThrow(/greater than zero/);
    });

    it('more than the line-item cap', () => {
      const tooMany = Array.from({ length: MAX_LINE_ITEMS + 1 }, () => line(1, 100));
      expect(() => computeTotals(tooMany)).toThrow(/more than 200 line items/);
    });

    it('Int32 overflow on a single line', () => {
      expect(() => computeTotals([line(1000, MAX_ORDER_CENTS)])).toThrow(MoneyError);
    });

    it('Int32 overflow accumulated across lines', () => {
      const half = Math.floor(MAX_ORDER_CENTS / 2) + 1000;
      expect(() => computeTotals([line(1, half), line(1, half)])).toThrow(/subtotal/);
    });
  });

  it('names the offending line in the error', () => {
    expect(() => computeTotals([line(1, 500), line(0, 500)])).toThrow(/line 2/);
  });
});
