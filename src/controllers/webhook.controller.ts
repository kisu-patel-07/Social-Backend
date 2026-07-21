import { Request, Response } from 'express';
import { logger } from '../config/logger';
import { HttpStatus } from '../constants/httpStatus';
import { webhookService } from '../services';
import { verifyWebhookChallenge, verifyWebhookSignature } from '../services/meta';
import { asyncHandler } from '../utils/asyncHandler';

export const webhookController = {
  /** GET — Meta webhook verification handshake during subscription setup. */
  verify: (req: Request, res: Response): void => {
    const challenge = verifyWebhookChallenge(
      req.query['hub.mode'] as string,
      req.query['hub.verify_token'] as string,
      req.query['hub.challenge'] as string
    );
    if (challenge) {
      res.status(HttpStatus.OK).send(challenge);
      return;
    }
    res.sendStatus(HttpStatus.FORBIDDEN);
  },

  /**
   * POST — receive webhook events. Verify the signature, process the events,
   * then ACK with 200 (Meta retries on non-2xx).
   *
   * NOTE: processing is awaited BEFORE responding. On serverless (Vercel), the
   * function is frozen the instant a response is sent, so any fire-and-forget
   * work after res.send() would be killed and automations would silently never
   * run. Awaiting is safe because event handling is idempotent (per-event
   * externalId), so Meta's retry-on-timeout never double-sends.
   */
  receive: asyncHandler(async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    const body = req.body as { object?: string; entry?: Array<{ id?: string }> };
    logger.info('Webhook POST received', {
      object: body?.object,
      entryIds: body?.entry?.map((e) => e.id),
      hasSignature: Boolean(signature),
    });

    if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Rejected webhook with invalid signature');
      res.sendStatus(HttpStatus.FORBIDDEN);
      return;
    }

    try {
      await webhookService.process(req.body);
    } catch (error) {
      // Swallow — still ACK so Meta doesn't hammer retries; idempotency guards
      // any reprocessing on the next delivery.
      logger.error('Webhook processing error', { error: (error as Error).message });
    }
    res.sendStatus(HttpStatus.OK);
  }),
};
