import { brevoClient } from './brevo.client';
import { emailTemplates } from './templates';

/**
 * High-level email service. Controllers/services call these semantic methods
 * rather than constructing email bodies themselves.
 */
class EmailService {
  sendWelcome(to: string, name: string): Promise<void> {
    const c = emailTemplates.welcome(name);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }

  sendVerification(to: string, name: string, verifyUrl: string): Promise<void> {
    const c = emailTemplates.verifyEmail(name, verifyUrl);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }

  sendPasswordReset(to: string, name: string, resetUrl: string): Promise<void> {
    const c = emailTemplates.resetPassword(name, resetUrl);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }

  sendNewLead(
    to: string,
    name: string,
    leadName: string,
    platform: string,
    link: string
  ): Promise<void> {
    const c = emailTemplates.newLead(name, leadName, platform, link);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }

  sendWeeklyReport(
    to: string,
    name: string,
    stats: { comments: number; dms: number; leads: number },
    link: string
  ): Promise<void> {
    const c = emailTemplates.weeklyReport(name, stats, link);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }

  sendSubscriptionUpdate(to: string, name: string, message: string): Promise<void> {
    const c = emailTemplates.subscription(name, message);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }
}

export const emailService = new EmailService();
