import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ExternalServiceError } from '../../utils/AppError';

export interface SendEmailParams {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailOptions {
  /**
   * Critical emails (e.g. verification codes) must not fail silently: on send
   * failure `send()` throws so the caller can react. Non-critical emails
   * (welcome, digests, notifications) are best-effort and swallow errors so a
   * mail outage never breaks the primary request.
   */
  critical?: boolean;
}

/**
 * Thin wrapper around Brevo's transactional email REST API.
 * When EMAIL_DRY_RUN is enabled (default in dev) or no API key is configured,
 * emails are logged instead of sent so local development needs no credentials.
 */
class BrevoClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.brevo.com/v3',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15000,
    });
  }

  async send(params: SendEmailParams, options: SendEmailOptions = {}): Promise<void> {
    const dryRun = env.EMAIL_DRY_RUN || !env.BREVO_API_KEY;

    if (dryRun) {
      // Log the text body too so dev flows (verification codes/links) are usable.
      logger.info('[email:dry-run] would send email', {
        to: params.to.email,
        subject: params.subject,
        body: params.text,
      });
      return;
    }

    const replyTo = env.BREVO_REPLY_TO || env.BREVO_SENDER_EMAIL;

    try {
      await this.http.post('/smtp/email', {
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        replyTo: { email: replyTo, name: env.BREVO_SENDER_NAME },
        to: [{ email: params.to.email, name: params.to.name }],
        subject: params.subject,
        htmlContent: params.html,
        textContent: params.text,
      });
      logger.info('Email sent', { to: params.to.email, subject: params.subject });
    } catch (error) {
      const detail = axios.isAxiosError(error) ? error.response?.data : error;
      logger.error('Failed to send email via Brevo', { to: params.to.email, detail });
      // Critical emails propagate so the flow can tell the user it failed;
      // non-critical ones are best-effort and swallowed.
      if (options.critical) {
        throw new ExternalServiceError('Failed to send email', detail);
      }
    }
  }
}

export const brevoClient = new BrevoClient();
