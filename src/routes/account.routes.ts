import { Router } from 'express';
import { accountController } from '../controllers/account.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  accountIdParamSchema,
  connectAccountSchema,
  oauthCallbackSchema,
  startOAuthSchema,
} from '../validators/account.validator';

const router = Router();

// OAuth callback can be hit by Meta's redirect; it does not require auth here
// because it only resolves connectable entities (no data is persisted).
router.get('/oauth/callback', validate(oauthCallbackSchema), accountController.oauthCallback);

router.use(authenticate);

router.get('/', accountController.list);
router.get('/oauth/url', validate(startOAuthSchema), accountController.startOAuth);
router.post('/connect', validate(connectAccountSchema), accountController.connect);
router.get('/:id', validate(accountIdParamSchema), accountController.getById);
router.delete('/:id', validate(accountIdParamSchema), accountController.disconnect);

export default router;
