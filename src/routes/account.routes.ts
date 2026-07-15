import { Router } from 'express';
import { accountController } from '../controllers/account.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import { requireActiveSubscription } from '../services/subscription.service';
import {
  accountIdParamSchema,
  connectAccountSchema,
  listMediaSchema,
  oauthCallbackSchema,
  startOAuthSchema,
} from '../validators/account.validator';

const router = Router();

// OAuth callback can be hit by Meta's redirect; it does not require auth here
// because it only resolves connectable entities (no data is persisted).
router.get('/oauth/callback', validate(oauthCallbackSchema), accountController.oauthCallback);

router.use(authenticate);

router.get('/', accountController.list);
// Connecting new accounts is gated on an active trial/subscription.
router.get(
  '/oauth/url',
  requireActiveSubscription,
  validate(startOAuthSchema),
  accountController.startOAuth
);
router.post(
  '/connect',
  requireActiveSubscription,
  validate(connectAccountSchema),
  accountController.connect
);
router.get('/:id', validate(accountIdParamSchema), accountController.getById);
router.get('/:id/media', validate(listMediaSchema), accountController.listMedia);
router.post(
  '/:id/subscribe-webhook',
  validate(accountIdParamSchema),
  accountController.retryWebhook
);
router.delete('/:id', validate(accountIdParamSchema), accountController.disconnect);

export default router;
