import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError, BadRequestError } from '../utils/AppError';
import { HttpStatus } from '../constants/httpStatus';

/**
 * Thin Razorpay wrapper. The gateway is optional: when keys are absent the
 * app runs with payments disabled and the billing page falls back to
 * "Request upgrade" (admin activates manually).
 */
class PaymentService {
  private client: Razorpay | null = null;

  isConfigured(): boolean {
    return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  }

  get keyId(): string {
    return env.RAZORPAY_KEY_ID;
  }

  /** Whether the Razorpay webhook secret is configured. */
  get webhookConfigured(): boolean {
    return Boolean(env.RAZORPAY_WEBHOOK_SECRET);
  }

  /**
   * Verify a Razorpay webhook: HMAC-SHA256 of the raw request body with the
   * webhook secret must equal the `X-Razorpay-Signature` header.
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  }

  private getClient(): Razorpay {
    if (!this.isConfigured()) {
      throw new AppError('Online payment is not configured yet', HttpStatus.SERVICE_UNAVAILABLE, {
        errorCode: 'PAYMENT_NOT_CONFIGURED',
      });
    }
    if (!this.client) {
      this.client = new Razorpay({
        key_id: env.RAZORPAY_KEY_ID,
        key_secret: env.RAZORPAY_KEY_SECRET,
      });
    }
    return this.client;
  }

  /** Create a Razorpay order the client-side Checkout will collect against. */
  async createOrder(params: {
    amount: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ orderId: string; amount: number; currency: string }> {
    const client = this.getClient();
    try {
      const order = await client.orders.create({
        amount: params.amount,
        currency: params.currency,
        receipt: params.receipt,
        notes: params.notes,
      });
      return {
        orderId: order.id,
        amount: Number(order.amount),
        currency: order.currency,
      };
    } catch (error) {
      // Surface Razorpay's actual reason (e.g. "Currency is not supported by the
      // account") instead of a generic 500, so the billing UI is actionable.
      const rzp = error as {
        statusCode?: number;
        error?: { description?: string; code?: string };
      };
      const description = rzp?.error?.description ?? (error as Error)?.message;
      logger.error('Razorpay order creation failed', {
        description,
        code: rzp?.error?.code,
        statusCode: rzp?.statusCode,
        currency: params.currency,
        amount: params.amount,
      });
      throw new AppError(
        `Payment gateway error: ${description ?? 'could not create the order'}`,
        HttpStatus.BAD_GATEWAY,
        { errorCode: 'RAZORPAY_ORDER_FAILED' }
      );
    }
  }

  /**
   * Verify Razorpay's checkout signature: HMAC-SHA256(order_id|payment_id)
   * with the key secret must equal the signature the client received.
   */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): void {
    if (!this.isConfigured()) {
      throw new BadRequestError('Online payment is not configured');
    }
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    const valid =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!valid) {
      throw new BadRequestError('Payment verification failed — signature mismatch');
    }
  }
}

export const paymentService = new PaymentService();
