import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authLimiter } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  forgotPasswordSchema,
  loginSchema,
  oauthFacebookSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '../validators/auth.validator';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), authController.register);
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshSchema), authController.refresh);
router.post('/logout', authController.logout);
router.post('/verify-email', validate(verifyEmailSchema), authController.verifyEmail);
router.post(
  '/resend-verification',
  authLimiter,
  validate(resendVerificationSchema),
  authController.resendVerification
);
router.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  authController.forgotPassword
);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);
router.post('/facebook', authLimiter, validate(oauthFacebookSchema), authController.facebookLogin);

export default router;
