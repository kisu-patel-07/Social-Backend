import { Router } from 'express';
import { analyticsController } from '../controllers/analytics.controller';
import { authenticate } from '../middlewares';

const router = Router();

router.use(authenticate);

router.get('/dashboard', analyticsController.dashboard);
router.get('/overview', analyticsController.overview);

export default router;
