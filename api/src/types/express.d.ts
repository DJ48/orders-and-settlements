import type { Types } from 'mongoose';

/**
 * Augments Express's Request type rather than casting `req as any` at every call site.
 * `requestId` is set unconditionally by the first middleware in the chain (see app.ts), so it's
 * typed as required even though Express itself can't statically enforce that ordering.
 */
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: { id: Types.ObjectId };
    }
  }
}

export {};
