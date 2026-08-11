import { Router } from 'express';
import {
  getOrders,
  postOrder,
  getOrderById,
  patchOrder,
  deleteOrderById,
} from '../controllers/orders.controller';
import { postPayment } from '../controllers/payments.controller';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

// Every order route requires a session — there is no notion of a public order.
router.use(requireAuth);

router.get('/', getOrders);
router.post('/', postOrder);
router.get('/:id', getOrderById);
router.patch('/:id', patchOrder);
router.delete('/:id', deleteOrderById);
router.post('/:id/payments', postPayment);

export default router;
