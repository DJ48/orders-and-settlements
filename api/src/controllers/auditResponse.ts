import type { LeanAuditLog } from '../models/AuditLog';
import { deriveStatus, type OrderStatus } from '../utils/status';

/**
 * Shapes an audit row for the client.
 *
 * `actor.ip` and `actor.userAgent` are deliberately NOT exposed. They're recorded because an
 * audit trail that can't answer "from where" is half an audit trail, but the order timeline is a
 * product surface, not a forensics console — and echoing an IP into a page that gets screenshotted
 * and pasted into tickets spreads it further than it needs to go. `requestId` is exposed instead:
 * it correlates a timeline row with the log line and the error the client saw, which is the part
 * a support conversation actually needs.
 */
export interface AuditEntryResponse {
  _id: string;
  action: string;
  at: string;
  requestId?: string;
  /** The order's status as it stood immediately after this event — derived here, never stored. */
  status?: OrderStatus;
  snapshot?: { totalCents?: number; amountPaidCents?: number; settlementState?: string };
  delta?: Record<string, unknown>;
}

/**
 * Status is derived server-side per entry for the same reason it's derived on an order response:
 * the frontend must never re-implement what "paid" or "overdue" means. Evaluated `at` the moment
 * the event happened, not today, so a row reads as it did then.
 *
 * Entries written before `dueDate` joined the snapshot simply have no status. Backfilling one by
 * guessing today's due date would put a confidently wrong value on a historical record, which is
 * worse than an absent one on an audit trail.
 */
function statusAt(entry: LeanAuditLog): OrderStatus | undefined {
  const snap = entry.snapshot;
  if (!snap?.dueDate || snap.totalCents == null || snap.amountPaidCents == null) return undefined;

  return deriveStatus({
    amountPaidCents: snap.amountPaidCents,
    totalCents: snap.totalCents,
    dueDate: snap.dueDate,
    now: new Date(entry.at),
  });
}

export function toAuditEntryResponse(entry: LeanAuditLog): AuditEntryResponse {
  return {
    _id: String(entry._id),
    action: entry.action,
    at: new Date(entry.at).toISOString(),
    requestId: entry.requestId ?? undefined,
    status: statusAt(entry),
    snapshot: entry.snapshot
      ? {
          totalCents: entry.snapshot.totalCents ?? undefined,
          amountPaidCents: entry.snapshot.amountPaidCents ?? undefined,
          settlementState: entry.snapshot.settlementState ?? undefined,
        }
      : undefined,
    delta: (entry.delta as Record<string, unknown> | undefined) ?? undefined,
  };
}
