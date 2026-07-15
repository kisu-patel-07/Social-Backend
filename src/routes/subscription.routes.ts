import { Router } from 'express';
import { z } from 'zod';
import { subscriptionController } from '../controllers/subscription.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import { objectIdSchema } from '../validators/common.validator';

const planBodySchema = z.object({ body: z.object({ planId: objectIdSchema }) });

const checkoutVerifySchema = z.object({
  body: z.object({
    planId: objectIdSchema,
    razorpayOrderId: z.string().min(1),
    razorpayPaymentId: z.string().min(1),
    razorpaySignature: z.string().min(1),
  }),
});

const router = Router();

// Public pricing table.
router.get('/plans', subscriptionController.listPlans);

router.use(authenticate);
router.get('/current', subscriptionController.current);
router.get('/invoices', subscriptionController.invoices);
// Self-serve: free plans switch instantly; paid plans pay via Razorpay checkout.
// request-upgrade remains as the fallback while gateway keys are not configured.
router.post('/choose', validate(planBodySchema), subscriptionController.choose);
router.post('/checkout', validate(planBodySchema), subscriptionController.checkout);
router.post(
  '/checkout/verify',
  validate(checkoutVerifySchema),
  subscriptionController.checkoutVerify
);
router.post('/request-upgrade', validate(planBodySchema), subscriptionController.requestUpgrade);

export default router;
