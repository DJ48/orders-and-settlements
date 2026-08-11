import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import * as ordersService from '../services/orders.service';
import { ValidationError } from '../utils/errors';
import { ORDER_STATUSES, utcDateOnly } from '../utils/status';
import { toOrderResponse, toOrderSummaryResponse } from './orderResponse';
import { toOrdersCsv } from './orderCsv';

/**
 * Controllers stay thin: validate with zod, call a service, shape the response. The derived
 * fields (status, amountDueCents, paidLate, canEditLineItems) are computed here rather than
 * stored, so every response is guaranteed consistent with the pure functions in utils/status.ts
 * — there's no separate "status" field on the document that could disagree with them.
 */

const LineItemInputSchema = z.object({
  description: z.string().trim().min(1, 'Description is required').max(200),
  quantity: z.number().int('Quantity must be a whole number').min(1, 'Quantity must be at least 1'),
  unitPriceCents: z.number().int('Unit price must be a whole number of cents').min(0, 'Unit price cannot be negative'),
});

const CreateOrderSchema = z.object({
  customer: z.string().trim().min(1, 'Customer is required').max(200),
  dueDate: z.string().date('Enter a valid date (YYYY-MM-DD)'),
  lineItems: z.array(LineItemInputSchema).min(1, 'An order needs at least one line item'),
});

const UpdateOrderSchema = z.object({
  customer: z.string().trim().min(1, 'Customer is required').max(200).optional(),
  dueDate: z.string().date('Enter a valid date (YYYY-MM-DD)').optional(),
  lineItems: z.array(LineItemInputSchema).min(1, 'An order needs at least one line item').optional(),
});

const ListOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
});

const ExportOrdersQuerySchema = z
  .object({
    from: z.string().date('Enter a valid "from" date (YYYY-MM-DD)'),
    to: z.string().date('Enter a valid "to" date (YYYY-MM-DD)'),
  })
  .refine((query) => query.from <= query.to, {
    // Plain string comparison is safe here — both are already zod-validated YYYY-MM-DD, and
    // that format sorts lexicographically the same as chronologically.
    message: '"from" must be on or before "to"',
    path: ['from'],
  });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw ValidationError.fromZodError(result.error as ZodError);
  return result.data;
}

function requestContext(req: Request): ordersService.RequestContext {
  return { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId };
}

export async function getOrders(req: Request, res: Response): Promise<void> {
  const query = parse(ListOrdersQuerySchema, req.query);
  const orders = await ordersService.listOrders(req.user!.id, { status: query.status });
  res.json(orders.map(toOrderSummaryResponse));
}

export async function getOrdersExport(req: Request, res: Response): Promise<void> {
  const query = parse(ExportOrdersQuerySchema, req.query);
  const orders = await ordersService.exportOrdersInRange(req.user!.id, {
    from: utcDateOnly(new Date(query.from)),
    to: utcDateOnly(new Date(query.to)),
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders_${query.from}_to_${query.to}.csv"`);
  res.status(200).send(toOrdersCsv(orders));
}

export async function postOrder(req: Request, res: Response): Promise<void> {
  const input = parse(CreateOrderSchema, req.body);
  const order = await ordersService.createOrder(req.user!.id, input, requestContext(req));
  res.status(201).json(toOrderResponse(order));
}

export async function getOrderById(req: Request, res: Response): Promise<void> {
  const order = await ordersService.getOrder(req.user!.id, req.params.id as string);
  res.json(toOrderResponse(order));
}

export async function patchOrder(req: Request, res: Response): Promise<void> {
  const input = parse(UpdateOrderSchema, req.body);
  const order = await ordersService.updateOrder(req.user!.id, req.params.id as string, input, requestContext(req));
  res.json(toOrderResponse(order));
}

export async function deleteOrderById(req: Request, res: Response): Promise<void> {
  await ordersService.deleteOrder(req.user!.id, req.params.id as string, requestContext(req));
  res.status(204).end();
}
