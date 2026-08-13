import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import * as ordersService from '../services/orders.service';
import { ValidationError } from '../utils/errors';
import { ORDER_STATUSES, utcDateOnly } from '../utils/status';
import { toOrderResponse, toOrderSummaryResponse } from './orderResponse';
import { toOrdersCsv } from './orderCsv';
import { toAuditEntryResponse } from './auditResponse';
import { listOrderAudit } from '../services/audit.service';

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

/**
 * Both from/to optional on both schemas below — omitting both means no date filter, matching how
 * ?status= itself is optional. What's not allowed is exactly one: a range needs two ends, and a
 * lone bound would be ambiguous (from-only reads like "since X", which nothing here promises).
 * The two schemas repeat this shape rather than sharing a generic builder — zod's `.refine()`
 * typing doesn't infer cleanly through a generic wrapper, and the two definitions are short
 * enough that the duplication is cheaper than fighting the type checker over it.
 */
const ListOrdersQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    from: z.string().date('Enter a valid "from" date (YYYY-MM-DD)').optional(),
    to: z.string().date('Enter a valid "to" date (YYYY-MM-DD)').optional(),
    page: z.coerce.number().int('Page must be a whole number').min(1, 'Page must be at least 1').optional(),
    pageSize: z.coerce
      .number()
      .int('Page size must be a whole number')
      .min(1, 'Page size must be at least 1')
      .max(ordersService.MAX_PAGE_SIZE, `Page size cannot exceed ${ordersService.MAX_PAGE_SIZE}`)
      .optional(),
  })
  .refine((query) => (query.from === undefined) === (query.to === undefined), {
    message: 'Provide both "from" and "to", or neither',
    path: ['from'],
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    // Plain string comparison is safe here — both are already zod-validated YYYY-MM-DD, and
    // that format sorts lexicographically the same as chronologically.
    message: '"from" must be on or before "to"',
    path: ['from'],
  });

const ExportOrdersQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    from: z.string().date('Enter a valid "from" date (YYYY-MM-DD)').optional(),
    to: z.string().date('Enter a valid "to" date (YYYY-MM-DD)').optional(),
  })
  .refine((query) => (query.from === undefined) === (query.to === undefined), {
    message: 'Provide both "from" and "to", or neither',
    path: ['from'],
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
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
  const result = await ordersService.listOrders(req.user!.id, {
    status: query.status,
    dueDateFrom: query.from ? utcDateOnly(new Date(query.from)) : undefined,
    dueDateTo: query.to ? utcDateOnly(new Date(query.to)) : undefined,
    page: query.page,
    pageSize: query.pageSize,
  });

  res.json({
    orders: result.orders.map(toOrderSummaryResponse),
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages: result.totalPages,
    summary: result.summary,
  });
}

export async function getOrdersExport(req: Request, res: Response): Promise<void> {
  const query = parse(ExportOrdersQuerySchema, req.query);
  const orders = await ordersService.exportOrders(req.user!.id, {
    status: query.status,
    from: query.from ? utcDateOnly(new Date(query.from)) : undefined,
    to: query.to ? utcDateOnly(new Date(query.to)) : undefined,
  });

  const filenameSuffix = query.from && query.to ? `_${query.from}_to_${query.to}` : '_all';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders${filenameSuffix}.csv"`);
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

/**
 * Resolving the order first is what enforces ownership: getOrder() throws NotFoundError for an id
 * that doesn't exist OR belongs to someone else, so a foreign id can't be probed by watching the
 * timeline come back empty instead of 404.
 */
export async function getOrderAudit(req: Request, res: Response): Promise<void> {
  const order = await ordersService.getOrder(req.user!.id, req.params.id as string);
  const entries = await listOrderAudit(order._id);
  res.json({ entries: entries.map(toAuditEntryResponse) });
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
