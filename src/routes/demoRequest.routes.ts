import { Router } from 'express';
import { z } from 'zod';
import { DemoRequestTopic } from '../constants';
import { demoRequestController } from '../controllers/demoRequest.controller';
import { authLimiter } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';

const demoRequestSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().max(30).optional(),
    topic: z.nativeEnum(DemoRequestTopic).default(DemoRequestTopic.DEMO),
    preferredDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
      .optional(),
    preferredSlot: z.string().trim().max(60).optional(),
    message: z.string().trim().max(2000).optional(),
  }),
});

const router = Router();

// Public + strictly rate-limited (shares the auth limiter) to deter spam.
router.post('/', authLimiter, validate(demoRequestSchema), demoRequestController.submit);

export default router;
