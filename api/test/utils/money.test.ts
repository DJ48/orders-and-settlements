import { describe, it, expect } from 'vitest';
import {
  parseCents,
  formatCents,
  assertWithinRange,
  MoneyError,
  MAX_ORDER_CENTS,
} from '../../src/utils/money';

describe('parseCents', () => {
  it('parses decimal strings', () => {
    expect(parseCents('10.99')).toBe(1099);
    expect(parseCents('1000')).toBe(100_000);
    expect(parseCents('0.05')).toBe(5);
    expect(parseCents('500.00')).toBe(50_000);
  });

  it('pads a single decimal place rather than misreading it', () => {
    expect(parseCents('0.5')).toBe(50); // 50 cents, not 5
  });

  it('accepts numbers as well as strings', () => {
    expect(parseCents(1000)).toBe(100_000);
    expect(parseCents(10.99)).toBe(1099);
  });

  it('handles negatives, which refunds will need', () => {
    expect(parseCents('-10.99')).toBe(-1099);
  });

  it('refuses anything it would have to guess about', () => {
    expect(() => parseCents('1.005')).toThrow(MoneyError); // round up or down?
    expect(() => parseCents('abc')).toThrow(MoneyError);
    expect(() => parseCents('1e5')).toThrow(MoneyError);
    expect(() => parseCents('')).toThrow(MoneyError);
    expect(() => parseCents('10,99')).toThrow(MoneyError);
  });
});

describe('formatCents', () => {
  it('always renders two decimal places', () => {
    expect(formatCents(1099)).toBe('10.99');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(50)).toBe('0.50');
    expect(formatCents(100_000)).toBe('1000.00');
    expect(formatCents(0)).toBe('0.00');
  });

  it('puts the sign in front of the whole value', () => {
    expect(formatCents(-1099)).toBe('-10.99');
    expect(formatCents(-5)).toBe('-0.05');
  });

  it('round-trips with parseCents', () => {
    for (const value of ['0.01', '10.99', '1844.37', '21474836.47']) {
      expect(formatCents(parseCents(value))).toBe(value);
    }
  });
});

describe('why this module exists at all', () => {
  // These are real amounts whose IEEE-754 sum is not the value a human would write.
  // With floats, an order settled in two instalments would sit at `partially_paid` forever
  // and reject its own final payment as an over-payment.
  it.each([
    ['352.23', '1492.14', '1844.37'],
    ['165.44', '668.65', '834.09'],
    ['1824.09', '1167.56', '2991.65'],
  ])('%s + %s settles exactly to %s', (a, b, total) => {
    expect(parseCents(a) + parseCents(b)).toBe(parseCents(total));
  });

  it('the same sums are inexact in floating point', () => {
    expect(352.23 + 1492.14).not.toBe(1844.37);
    expect(165.44 + 668.65).not.toBe(834.09);
  });
});

describe('assertWithinRange', () => {
  it('permits values up to the Int32 ceiling', () => {
    expect(() => assertWithinRange(MAX_ORDER_CENTS)).not.toThrow();
  });

  it('rejects overflow rather than letting BSON promote to Double', () => {
    expect(() => assertWithinRange(MAX_ORDER_CENTS + 1)).toThrow(MoneyError);
  });

  it('rejects fractional cents', () => {
    expect(() => assertWithinRange(10.5)).toThrow(MoneyError);
  });

  it('names the field in the error, so the API can surface it', () => {
    expect(() => assertWithinRange(10.5, 'line 2 unit price')).toThrow(/line 2 unit price/);
  });
});
