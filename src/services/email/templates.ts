import { env } from '../../config/env';

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const baseStyles = `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.6;`;

/** Wrap body HTML in a simple, brand-consistent layout. */
function layout(title: string, bodyHtml: string): string {
  return `
  <div style="${baseStyles}max-width:560px;margin:0 auto;padding:24px;">
    <h1 style="font-size:20px;margin:0 0 16px;">${env.BREVO_SENDER_NAME}</h1>
    <h2 style="font-size:18px;margin:0 0 12px;">${title}</h2>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:12px;color:#64748b;">
      You received this email because you have an account with ${env.BREVO_SENDER_NAME}.
    </p>
  </div>`;
}

function button(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;">${label}</a>`;
}

export const emailTemplates = {
  welcome(name: string): EmailContent {
    return {
      subject: `Welcome to ${env.BREVO_SENDER_NAME} 🎉`,
      html: layout(
        `Welcome, ${name}!`,
        `<p>Thanks for joining ${env.BREVO_SENDER_NAME}. Connect your Instagram Business or Facebook Page to start automating comment-to-DM replies.</p>`
      ),
      text: `Welcome, ${name}! Thanks for joining ${env.BREVO_SENDER_NAME}.`,
    };
  },

  verifyEmail(name: string, verifyUrl: string): EmailContent {
    return {
      subject: 'Verify your email address',
      html: layout(
        `Hi ${name},`,
        `<p>Please confirm your email address to activate your account.</p><p>${button(
          'Verify Email',
          verifyUrl
        )}</p><p style="font-size:13px;color:#64748b;">Or paste this link: ${verifyUrl}</p>`
      ),
      text: `Hi ${name}, verify your email: ${verifyUrl}`,
    };
  },

  resetPassword(name: string, resetUrl: string): EmailContent {
    return {
      subject: 'Reset your password',
      html: layout(
        `Hi ${name},`,
        `<p>We received a request to reset your password. This link expires soon.</p><p>${button(
          'Reset Password',
          resetUrl
        )}</p><p style="font-size:13px;color:#64748b;">If you didn't request this, you can ignore this email.</p>`
      ),
      text: `Hi ${name}, reset your password: ${resetUrl}`,
    };
  },

  newLead(name: string, leadName: string, platform: string, link: string): EmailContent {
    return {
      subject: `New lead from ${platform} 🎯`,
      html: layout(
        `Hi ${name},`,
        `<p>You have a new lead: <strong>${leadName}</strong> from <strong>${platform}</strong>.</p><p>${button(
          'View Lead',
          link
        )}</p>`
      ),
      text: `New lead: ${leadName} from ${platform}. ${link}`,
    };
  },

  weeklyReport(
    name: string,
    stats: { comments: number; dms: number; leads: number },
    link: string
  ): EmailContent {
    return {
      subject: 'Your weekly report 📊',
      html: layout(
        `Hi ${name},`,
        `<p>Here's your activity from the past 7 days:</p>
         <ul>
           <li>Comments triggered: <strong>${stats.comments}</strong></li>
           <li>DMs sent: <strong>${stats.dms}</strong></li>
           <li>New leads: <strong>${stats.leads}</strong></li>
         </ul>
         <p>${button('Open Dashboard', link)}</p>`
      ),
      text: `Weekly report — comments: ${stats.comments}, DMs: ${stats.dms}, leads: ${stats.leads}.`,
    };
  },

  subscription(name: string, message: string): EmailContent {
    return {
      subject: 'Subscription update',
      html: layout(`Hi ${name},`, `<p>${message}</p>`),
      text: message,
    };
  },
};

export type { EmailContent };
