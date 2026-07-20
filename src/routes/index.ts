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
import adminRoutes from './admin.routes';
import contactRoutes from './contact.routes';
import giveawayRoutes from './giveaway.routes';
import { linkTrackingService } from '../services/linkTracking.service';
import { asyncHandler } from '../utils/asyncHandler';
import { env } from '../config/env';

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
router.use('/admin', adminRoutes);
router.use('/contact', contactRoutes);
router.use('/giveaway', giveawayRoutes);

// Public tracked-link redirect — clicked from users' DMs, so no auth.
router.get(
  '/r/:slug',
  asyncHandler(async (req, res) => {
    const target = await linkTrackingService.resolveClick(req.params.slug);
    res.redirect(302, target ?? env.CLIENT_URL.split(',')[0]);
  })
);

export default router;
