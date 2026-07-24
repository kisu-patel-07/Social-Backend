import { env } from '../../config/env';
import { htmlEscape } from '../../utils/text';

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
        `Welcome, ${htmlEscape(name)}!`,
        `<p>Thanks for joining ${env.BREVO_SENDER_NAME}. Connect your Instagram Business or Facebook Page to start automating comment-to-DM replies.</p>`
      ),
      text: `Welcome, ${name}! Thanks for joining ${env.BREVO_SENDER_NAME}.`,
    };
  },

  verifyEmail(name: string, verifyUrl: string, otp: string): EmailContent {
    return {
      subject: `${otp} is your verification code`,
      html: layout(
        `Hi ${htmlEscape(name)},`,
        `<p>Enter this code to verify your email address:</p>
         <p style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;background:#f1f5f9;border-radius:12px;padding:16px 8px;margin:16px 0;">${otp}</p>
         <p style="font-size:13px;color:#64748b;">The code expires in 10 minutes.</p>
         <p>Or verify with one click:</p><p>${button('Verify Email', verifyUrl)}</p>
         <p style="font-size:13px;color:#64748b;">If the button doesn't work, paste this link: ${verifyUrl}</p>`
      ),
      text: `Hi ${name}, your verification code is ${otp} (expires in 10 minutes). Or verify via link: ${verifyUrl}`,
    };
  },

  resetPassword(name: string, resetUrl: string): EmailContent {
    return {
      subject: 'Reset your password',
      html: layout(
        `Hi ${htmlEscape(name)},`,
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
        `Hi ${htmlEscape(name)},`,
        `<p>You have a new lead: <strong>${htmlEscape(leadName)}</strong> from <strong>${htmlEscape(
          platform
        )}</strong>.</p><p>${button('View Lead', link)}</p>`
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
        `Hi ${htmlEscape(name)},`,
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
      html: layout(`Hi ${htmlEscape(name)},`, `<p>${htmlEscape(message)}</p>`),
      text: message,
    };
  },

  demoRequestReceived(name: string, topicLabel: string, preferred?: string): EmailContent {
    const preferredLine = preferred
      ? `<p>You asked for: <strong>${htmlEscape(preferred)}</strong>.</p>`
      : '';
    return {
      subject: `We got your request — ${topicLabel} 📅`,
      html: layout(
        `Hi ${htmlEscape(name)},`,
        `<p>Thanks for booking a <strong>${topicLabel.toLowerCase()}</strong> with ${env.BREVO_SENDER_NAME}!</p>
         ${preferredLine}
         <p>A real human will email you within 24 hours (Mon–Sat, IST) to confirm the exact time.</p>`
      ),
      text: `Hi ${name}, we received your ${topicLabel.toLowerCase()} request${preferred ? ` (preferred: ${preferred})` : ''}. We'll confirm the exact time within 24 hours (Mon–Sat, IST).`,
    };
  },

  demoCallScheduled(name: string, whenText: string, topicLabel: string): EmailContent {
    return {
      subject: `Your call is confirmed: ${whenText} ✅`,
      html: layout(
        `Hi ${htmlEscape(name)},`,
        `<p>Your <strong>${topicLabel.toLowerCase()}</strong> with ${env.BREVO_SENDER_NAME} is confirmed for:</p>
         <p style="font-size:20px;font-weight:700;text-align:center;background:#f1f5f9;border-radius:12px;padding:16px 8px;margin:16px 0;">${htmlEscape(
           whenText
         )}</p>
         <p>We'll send the meeting link to this email address before the call. Need to change the time? Just reply to this email.</p>`
      ),
      text: `Hi ${name}, your ${topicLabel.toLowerCase()} is confirmed for ${whenText}. We'll send the meeting link before the call. Reply to this email to reschedule.`,
    };
  },
};

export type { EmailContent };
