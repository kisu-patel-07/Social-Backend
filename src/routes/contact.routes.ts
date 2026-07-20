import { Router } from 'express';
import { z } from 'zod';
import { contactController } from '../controllers/contact.controller';
import { authLimiter } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';

const contactSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    subject: z.string().trim().min(2).max(120),
    message: z.string().trim().min(10).max(2000),
  }),
});

const router = Router();

// Public + strictly rate-limited (shares the auth limiter) to deter spam.
router.post('/', authLimiter, validate(contactSchema), contactController.submit);

export default router;
