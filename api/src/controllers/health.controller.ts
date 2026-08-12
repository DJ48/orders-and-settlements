import type { Request, Response } from 'express';
import { getConnection } from '../config/database';

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

/**
 * Readiness — can this instance actually serve a request that touches the database?
 *
 * A real round trip (`admin().ping()`), not just reading Mongoose's cached connection state —
 * `readyState === 1` can lag behind reality on some reconnect paths, and the whole point of a
 * readiness probe is to catch exactly the case where the process is "up" but its dependency
 * isn't. 503 on failure, so an orchestrator stops routing traffic here without restarting a
 * process that's otherwise fine (that's what liveness is for).
 */
export async function getReady(req: Request, res: Response): Promise<void> {
  const timestamp = new Date().toISOString();

  try {
    const db = getConnection().connection.db;
    if (!db) throw new Error('No database handle');
    await db.admin().ping();

    res.json({ status: 'ok', service: 'orders-and-settlements-api', timestamp });
  } catch (err) {
    req.log.warn({ err }, 'readiness check failed');
    res.status(503).json({
      status: 'error',
      service: 'orders-and-settlements-api',
      reason: 'database unavailable',
      timestamp,
    });
  }
}
