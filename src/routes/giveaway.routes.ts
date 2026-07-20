import { Router } from 'express';
import { z } from 'zod';
import { giveawayController } from '../controllers/giveaway.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import { requireActiveSubscription } from '../services/subscription.service';
import { objectIdSchema } from '../validators/common.validator';

const router = Router();

router.use(authenticate, requireActiveSubscription);

router.get(
  '/posts',
  validate(z.object({ query: z.object({ socialAccountId: objectIdSchema.optional() }) })),
  giveawayController.posts
);
router.post(
  '/pick',
  validate(
    z.object({
      body: z.object({
        postId: z.string().trim().min(1).max(120),
        socialAccountId: objectIdSchema.optional(),
        keyword: z.string().trim().max(80).optional(),
        count: z.coerce.number().int().min(1).max(10).optional(),
      }),
    })
  ),
  giveawayController.pick
);

export default router;
