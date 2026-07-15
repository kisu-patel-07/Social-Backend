import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env';
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
    const order = await this.getClient().orders.create({
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
