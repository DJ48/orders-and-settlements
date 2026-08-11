import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import * as paymentsService from '../services/payments.service';
import { ValidationError } from '../utils/errors';
import { toOrderResponse } from './orderResponse';

/**
 * Matches the brief's payment fields exactly: amount (≥ 0.01, so ≥ 1 cent), date, an optional
 * note. `idempotencyKey` is ours, not the brief's — the frontend mints one per payment attempt
 * so a retried click after a network hiccup replays the same key instead of double-charging.
 */
const RecordPaymentSchema = z.object({
  amountCents: z.number().int('Amount must be a whole number of cents').min(1, 'Amount must be at least 1 cent'),
  paidOn: z.string().date('Enter a valid date (YYYY-MM-DD)'),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().min(1, 'idempotencyKey is required').max(64),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw ValidationError.fromZodError(result.error as ZodError);
  return result.data;
}

export async function postPayment(req: Request, res: Response): Promise<void> {
  const input = parse(RecordPaymentSchema, req.body);
  const order = await paymentsService.recordPayment(
    req.user!.id,
    req.params.id as string,
    input,
    { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId },
  );
  res.status(201).json(toOrderResponse(order));
}
