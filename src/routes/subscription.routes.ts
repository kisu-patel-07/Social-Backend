import { Router } from 'express';
import { subscriptionController } from '../controllers/subscription.controller';
import { authenticate } from '../middlewares';

const router = Router();

// Public pricing table.
router.get('/plans', subscriptionController.listPlans);

router.use(authenticate);
router.get('/current', subscriptionController.current);
router.get('/invoices', subscriptionController.invoices);

export default router;
