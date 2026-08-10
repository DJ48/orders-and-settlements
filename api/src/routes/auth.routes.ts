import { Router } from 'express';
import { postSignup, postLogin, postLogout, getMe } from '../controllers/auth.controller';
import { requireAuth } from '../middlewares/requireAuth';
import { loginRateLimit } from '../middlewares/rateLimit';

const router = Router();

router.post('/signup', postSignup);
router.post('/login', loginRateLimit, postLogin);
router.post('/logout', postLogout);
router.get('/me', requireAuth, getMe);

export default router;
