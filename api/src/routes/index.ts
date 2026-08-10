import { Router } from 'express';
import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import ordersRoutes from './orders.routes';

/**
 * Every route in the API, mounted by `app.ts` under /api/v1.
 *
 * The version prefix lives here rather than in each route file, so it's declared once and
 * a future /api/v2 is a one-line change rather than a rename across the codebase.
 */
const router = Router();

router.use(healthRoutes);
router.use('/auth', authRoutes);
router.use('/orders', ordersRoutes);

export default router;
