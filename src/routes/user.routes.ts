import { Router } from 'express';
import { userController } from '../controllers/user.controller';
import { notificationController } from '../controllers/notification.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import { idParamSchema, paginationQuerySchema } from '../validators/common.validator';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

router.get('/me', userController.me);

// In-app notifications for the current user.
router.get(
  '/me/notifications',
  validate(z.object({ query: paginationQuerySchema })),
  notificationController.list
);
router.get('/me/notifications/unread-count', notificationController.unreadCount);
router.patch('/me/notifications/read-all', notificationController.markAllRead);
router.patch(
  '/me/notifications/:id/read',
  validate(z.object({ params: idParamSchema })),
  notificationController.markRead
);

export default router;
