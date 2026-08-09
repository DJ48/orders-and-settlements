import { describe, it, expect } from 'vitest';
import {
  deriveStatus,
  settlementStateFor,
  isPaidLate,
  amountDueCents,
  statusFilter,
  utcDateOnly,
} from '../../src/utils/status';

const TOTAL = 100_000; // $1,000.00
const NOW = new Date('2026-08-10T12:00:00Z');
const d = (iso: string) => new Date(iso);

describe('deriveStatus', () => {
  it('pending â€” no payments, not yet due', () => {
    expect(
      deriveStatus({ amountPaidCents: 0, totalCents: TOTAL, dueDate: d('2026-08-20'), now: NOW }),
    ).toBe('pending');
  });

  it('partially_paid â€” some payment, not yet due', () => {
    expect(
      deriveStatus({ amountPaidCents: 40_000, totalCents: TOTAL, dueDate: d('2026-08-20'), now: NOW }),
    ).toBe('partially_paid');
  });

  it('paid â€” payments equal the total', () => {
    expect(
      deriveStatus({ amountPaidCents: TOTAL, totalCents: TOTAL, dueDate: d('2026-08-20'), now: NOW }),
    ).toBe('paid');
  });

  describe('overdue precedence', () => {
    it('beats pending when nothing is paid', () => {
      expect(
        deriveStatus({ amountPaidCents: 0, totalCents: TOTAL, dueDate: d('2026-08-01'), now: NOW }),
      ).toBe('overdue');
    });

    it('beats partially_paid when something is paid', () => {
      expect(
        deriveStatus({ amountPaidCents: 40_000, totalCents: TOTAL, dueDate: d('2026-08-01'), now: NOW }),
      ).toBe('overdue');
    });

    it("loses to paid â€” the brief's named edge case", () => {
      // Was overdue, now settled. Status is a pure function of current state, so nothing lingers.
      expect(
        deriveStatus({ amountPaidCents: TOTAL, totalCents: TOTAL, dueDate: d('2026-08-01'), now: NOW }),
      ).toBe('paid');
    });
  });

  describe('date-only boundary', () => {
    it('an order due today is NOT overdue', () => {
      expect(
        deriveStatus({ amountPaidCents: 0, totalCents: TOTAL, dueDate: d('2026-08-10'), now: NOW }),
      ).toBe('pending');
    });

    it('becomes overdue the following day', () => {
      expect(
        deriveStatus({
          amountPaidCents: 0,
          totalCents: TOTAL,
          dueDate: d('2026-08-10'),
          now: d('2026-08-11T00:00:01Z'),
        }),
      ).toBe('overdue');
    });

    it('ignores time of day â€” late on the due date is still not overdue', () => {
      expect(
        deriveStatus({
          amountPaidCents: 0,
          totalCents: TOTAL,
          dueDate: d('2026-08-10T00:00:00Z'),
          now: d('2026-08-10T23:59:59Z'),
        }),
      ).toBe('pending');
    });
  });
});

describe('settlementStateFor', () => {
  it('maps the money axis only', () => {
    expect(settlementStateFor(0, TOTAL)).toBe('unpaid');
    expect(settlementStateFor(1, TOTAL)).toBe('partial');
    expect(settlementStateFor(TOTAL - 1, TOTAL)).toBe('partial');
    expect(settlementStateFor(TOTAL, TOTAL)).toBe('settled');
  });
});

describe('isPaidLate', () => {
  it('true when the settling payment landed after the due date', () => {
    expect(isPaidLate(d('2026-08-05'), d('2026-08-01'), TOTAL, TOTAL)).toBe(true);
  });

  it('false when it settled on time', () => {
    expect(isPaidLate(d('2026-07-30'), d('2026-08-01'), TOTAL, TOTAL)).toBe(false);
  });

  it('false while still outstanding, however late', () => {
    expect(isPaidLate(d('2026-08-05'), d('2026-08-01'), 40_000, TOTAL)).toBe(false);
  });

  it('false with no payments at all', () => {
    expect(isPaidLate(null, d('2026-08-01'), 0, TOTAL)).toBe(false);
  });
});

describe('amountDueCents', () => {
  it('never goes negative', () => {
    expect(amountDueCents(0, TOTAL)).toBe(TOTAL);
    expect(amountDueCents(40_000, TOTAL)).toBe(60_000);
    expect(amountDueCents(TOTAL, TOTAL)).toBe(0);
    expect(amountDueCents(TOTAL + 500, TOTAL)).toBe(0);
  });
});

describe('statusFilter', () => {
  const today = utcDateOnly(NOW);

  it('paid needs no date condition', () => {
    expect(statusFilter('paid', NOW)).toEqual({ settlementState: 'settled' });
  });

  it('overdue spans both unsettled states', () => {
    expect(statusFilter('overdue', NOW)).toEqual({
      settlementState: { $in: ['unpaid', 'partial'] },
      dueDate: { $lt: today },
    });
  });

  it('pending and partially_paid exclude past-due orders', () => {
    expect(statusFilter('pending', NOW)).toEqual({
      settlementState: 'unpaid',
      dueDate: { $gte: today },
    });
    expect(statusFilter('partially_paid', NOW)).toEqual({
      settlementState: 'partial',
      dueDate: { $gte: today },
    });
  });

  it('every branch is answerable by the dashboard index', () => {
    for (const status of ['pending', 'partially_paid', 'paid', 'overdue'] as const) {
      const keys = Object.keys(statusFilter(status, NOW));
      expect(keys.every((k) => k === 'settlementState' || k === 'dueDate')).toBe(true);
    }
  });
});
