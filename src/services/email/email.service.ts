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

  /** Verification email — critical: throws on send failure so the caller can react. */
  sendVerification(to: string, name: string, verifyUrl: string, otp: string): Promise<void> {
    const c = emailTemplates.verifyEmail(name, verifyUrl, otp);
    return brevoClient.send({ to: { email: to, name }, ...c }, { critical: true });
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

  sendDemoRequestReceived(
    to: string,
    name: string,
    topicLabel: string,
    preferred?: string
  ): Promise<void> {
    const c = emailTemplates.demoRequestReceived(name, topicLabel, preferred);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }

  sendDemoCallScheduled(
    to: string,
    name: string,
    whenText: string,
    topicLabel: string
  ): Promise<void> {
    const c = emailTemplates.demoCallScheduled(name, whenText, topicLabel);
    return brevoClient.send({ to: { email: to, name }, ...c });
  }
}

export const emailService = new EmailService();
