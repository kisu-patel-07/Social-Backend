import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

export interface SendEmailParams {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text?: string;
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

  async send(params: SendEmailParams): Promise<void> {
    const dryRun = env.EMAIL_DRY_RUN || !env.BREVO_API_KEY;

    if (dryRun) {
      logger.info('[email:dry-run] would send email', {
        to: params.to.email,
        subject: params.subject,
      });
      return;
    }

    try {
      await this.http.post('/smtp/email', {
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        to: [{ email: params.to.email, name: params.to.name }],
        subject: params.subject,
        htmlContent: params.html,
        textContent: params.text,
      });
      logger.info('Email sent', { to: params.to.email, subject: params.subject });
    } catch (error) {
      // Email failures should not break the primary request flow; log and move on.
      const detail = axios.isAxiosError(error) ? error.response?.data : error;
      logger.error('Failed to send email via Brevo', { to: params.to.email, detail });
    }
  }
}

export const brevoClient = new BrevoClient();
