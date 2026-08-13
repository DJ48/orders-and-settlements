import { Router } from 'express';
import {
  getOrders,
  getOrdersExport,
  postOrder,
  getOrderById,
  getOrderAudit,
  patchOrder,
  deleteOrderById,
} from '../controllers/orders.controller';
import { postPayment } from '../controllers/payments.controller';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

// Every order route requires a session — there is no notion of a public order.
router.use(requireAuth);

router.get('/', getOrders);
// Must come before /:id — Express matches routes in registration order, and 'export' would
// otherwise be swallowed as an order id (and rejected as an invalid ObjectId, 404).
router.get('/export', getOrdersExport);
router.post('/', postOrder);
router.get('/:id', getOrderById);
router.get('/:id/audit', getOrderAudit);
router.patch('/:id', patchOrder);
router.delete('/:id', deleteOrderById);
router.post('/:id/payments', postPayment);

export default router;
