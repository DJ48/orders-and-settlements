import type { LeanAuditLog } from '../models/AuditLog';

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
  snapshot?: { totalCents?: number; amountPaidCents?: number; settlementState?: string };
  delta?: Record<string, unknown>;
}

export function toAuditEntryResponse(entry: LeanAuditLog): AuditEntryResponse {
  return {
    _id: String(entry._id),
    action: entry.action,
    at: new Date(entry.at).toISOString(),
    requestId: entry.requestId ?? undefined,
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
