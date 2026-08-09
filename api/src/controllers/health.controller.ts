import type { Request, Response } from 'express';

/**
 * Liveness — is the process up and serving?
 *
 * Deliberately does NOT touch the database. A liveness probe that fails during a database
 * blip makes the platform restart a perfectly healthy process, which is the opposite of what
 * you want mid-incident. Readiness is the probe that checks dependencies.
 */
export function getHealth(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    service: 'orders-and-settlements-api',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
