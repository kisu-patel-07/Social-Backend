import { Router } from 'express';
import { inboxController } from '../controllers/inbox.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  listCommentsSchema,
  listConversationsSchema,
  replyMessageSchema,
  updateConversationStatusSchema,
} from '../validators/inbox.validator';
import { idParamSchema } from '../validators/common.validator';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

// Unified inbox: conversations + their messages.
router.get('/comments', validate(listCommentsSchema), inboxController.listComments);
router.get('/conversations', validate(listConversationsSchema), inboxController.listConversations);
router.get('/conversations/unread-count', inboxController.unreadCount);
router.get(
  '/conversations/:id',
  validate(z.object({ params: idParamSchema })),
  inboxController.getThread
);
router.patch(
  '/conversations/:id/status',
  validate(updateConversationStatusSchema),
  inboxController.setStatus
);
router.post('/conversations/:id/reply', validate(replyMessageSchema), inboxController.reply);

export default router;
