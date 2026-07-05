import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import accountRoutes from './account.routes';
import automationRoutes from './automation.routes';
import studioAutomationRoutes from './studioAutomation.routes';
import inboxRoutes from './inbox.routes';
import leadRoutes from './lead.routes';
import analyticsRoutes from './analytics.routes';
import settingsRoutes from './settings.routes';
import subscriptionRoutes from './subscription.routes';
import webhookRoutes from './webhook.routes';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ success: true, message: 'ok', data: { status: 'healthy' } });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/accounts', accountRoutes);
router.use('/automations', automationRoutes);
router.use('/studio-automations', studioAutomationRoutes);
router.use('/messages', inboxRoutes);
router.use('/leads', leadRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/settings', settingsRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/webhooks', webhookRoutes);

export default router;
