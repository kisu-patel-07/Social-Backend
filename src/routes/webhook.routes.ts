import { Router } from 'express';
import { webhookController } from '../controllers/webhook.controller';

const router = Router();

// Meta webhook endpoints. Signature verification happens in the controller
// using the raw body captured by the JSON body parser (see app.ts).
router.get('/meta', webhookController.verify);
router.post('/meta', webhookController.receive);

export default router;
