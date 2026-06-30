import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  changePasswordSchema,
  deleteAccountSchema,
  notificationPrefsSchema,
  updateProfileSchema,
  updateWorkspaceSchema,
} from '../validators/settings.validator';

const router = Router();

router.use(authenticate);

router.get('/profile', settingsController.getProfile);
router.put('/profile', validate(updateProfileSchema), settingsController.updateProfile);

router.get('/workspace', settingsController.getWorkspace);
router.put('/workspace', validate(updateWorkspaceSchema), settingsController.updateWorkspace);

router.put(
  '/notifications',
  validate(notificationPrefsSchema),
  settingsController.updateNotificationPrefs
);
router.put('/password', validate(changePasswordSchema), settingsController.changePassword);
router.delete('/account', validate(deleteAccountSchema), settingsController.deleteAccount);

export default router;
