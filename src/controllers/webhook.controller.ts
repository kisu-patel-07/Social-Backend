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
   * POST — receive webhook events. We verify the signature, immediately ACK
   * with 200 (Meta retries on non-2xx), then process events asynchronously.
   */
  receive: asyncHandler(async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Rejected webhook with invalid signature');
      res.sendStatus(HttpStatus.FORBIDDEN);
      return;
    }

    // Acknowledge first so Meta does not retry; process after responding.
    res.sendStatus(HttpStatus.OK);

    void webhookService.process(req.body).catch((error) => {
      logger.error('Webhook processing error', { error: (error as Error).message });
    });
  }),
};
