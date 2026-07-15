import { Request, Response } from 'express';
import { MessageDirection } from '../constants';
import { featureService, settingsService, subscriptionService } from '../services';
import { adminService } from '../services/admin.service';
import { paymentService } from '../services/payment.service';
import {
  automationRepository,
  messageRepository,
  socialAccountRepository,
  studioAutomationRepository,
} from '../repositories';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

export const userController = {
  /** Return the authenticated user, their workspace, subscription, flags and usage. */
  me: asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      profile,
      workspace,
      subscription,
      features,
      banner,
      entitlementState,
      connectedAccounts,
      classicAutomations,
      studioAutomations,
      messagesThisMonth,
    ] = await Promise.all([
      settingsService.getProfile(user.id),
      settingsService.getWorkspace(user.workspaceId),
      subscriptionService.getCurrent(user.workspaceId),
      featureService.flagsForWorkspace(user.workspaceId),
      adminService.getBanner(),
      subscriptionService.getEntitlements(user.workspaceId),
      socialAccountRepository.countActiveByWorkspace(user.workspaceId),
      automationRepository.count({ workspace: user.workspaceId }),
      studioAutomationRepository.count({ workspace: user.workspaceId }),
      messageRepository.count({
        workspace: user.workspaceId,
        direction: MessageDirection.OUTBOUND,
        createdAt: { $gte: startOfMonth },
      }),
    ]);

    // A feature is usable only when the admin flag AND the plan both allow it.
    const effectiveFeatures = {
      ...features,
      studio: (features.studio ?? true) && entitlementState.entitlements.studio,
    };

    sendSuccess(res, {
      user: profile,
      workspace,
      subscription,
      features: effectiveFeatures,
      entitlements: entitlementState.entitlements,
      limits: entitlementState.limits,
      usage: {
        connectedAccounts,
        automations: classicAutomations + studioAutomations,
        messagesThisMonth,
      },
      // Whether Razorpay checkout is available (falls back to request-upgrade).
      paymentsEnabled: paymentService.isConfigured(),
      // The operator-controlled maintenance banner (null when disabled).
      banner: banner.enabled ? banner : null,
      // Lets the client show the "viewing as" banner after a hard refresh.
      impersonation: user.isImpersonation === true,
    });
  }),
};
