import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError, BadRequestError } from '../utils/AppError';
import { HttpStatus } from '../constants/httpStatus';

/**
 * Razorpay subscription states that can never produce another charge, so a
 * failed cancel call against one of them still satisfies "stop charging me".
 * `created` = the customer never authorized the mandate in the first place.
 */
const NON_CHARGING_SUBSCRIPTION_STATES = ['created', 'cancelled', 'completed', 'expired', 'halted'];

/**
 * Thin Razorpay wrapper. The gateway is optional: when keys are absent the
 * app runs with payments disabled and the billing page falls back to
 * "Request upgrade" (admin activates manually).
 *
 * Two payment shapes are supported: one-time ORDERS (pay per period) and
 * SUBSCRIPTIONS (a saved mandate Razorpay charges every cycle by itself).
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

  /** Normalize a Razorpay SDK error into an actionable AppError. */
  private gatewayError(error: unknown, context: string, fallback: string): AppError {
    const rzp = error as { statusCode?: number; error?: { description?: string; code?: string } };
    const description = rzp?.error?.description ?? (error as Error)?.message;
    logger.error(`Razorpay ${context} failed`, {
      description,
      code: rzp?.error?.code,
      statusCode: rzp?.statusCode,
    });
    return new AppError(
      `Payment gateway error: ${description ?? fallback}`,
      HttpStatus.BAD_GATEWAY,
      { errorCode: 'RAZORPAY_ORDER_FAILED' }
    );
  }

  // --- Subscriptions (auto-renewing plans) ------------------------------------

  /**
   * Create the Razorpay-side plan that subscriptions bill against. Called by
   * `npm run razorpay:sync-plans`, once per local plan.
   */
  async createPlan(params: {
    period: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval: number;
    name: string;
    description?: string;
    amount: number;
    currency: string;
    notes?: Record<string, string>;
  }): Promise<{ planId: string }> {
    const client = this.getClient();
    try {
      const plan = await client.plans.create({
        period: params.period,
        interval: params.interval,
        item: {
          name: params.name,
          description: params.description,
          amount: params.amount,
          currency: params.currency,
        },
        notes: params.notes,
      });
      return { planId: plan.id };
    } catch (error) {
      throw this.gatewayError(error, 'plan creation', 'could not create the plan');
    }
  }

  /**
   * Start an auto-renewing subscription. The client opens Checkout against the
   * returned id; the customer authorizes a mandate (UPI Autopay / card e-mandate)
   * and Razorpay then charges every cycle on its own.
   */
  async createSubscription(params: {
    razorpayPlanId: string;
    totalCount: number;
    notes?: Record<string, string>;
  }): Promise<{ subscriptionId: string; status: string; shortUrl?: string }> {
    const client = this.getClient();
    try {
      const subscription = await client.subscriptions.create({
        plan_id: params.razorpayPlanId,
        total_count: params.totalCount,
        customer_notify: 1,
        notes: params.notes,
      });
      return {
        subscriptionId: subscription.id,
        status: String(subscription.status),
        shortUrl: (subscription as { short_url?: string }).short_url,
      };
    } catch (error) {
      throw this.gatewayError(error, 'subscription creation', 'could not start the subscription');
    }
  }

  /**
   * Stop future charges. `atCycleEnd` keeps the paid period usable and cancels
   * once it runs out (what the Cancel button does); false ends it immediately.
   * A Razorpay cancellation is TERMINAL — it cannot be undone, only re-created.
   */
  async cancelSubscription(subscriptionId: string, atCycleEnd = true): Promise<void> {
    const client = this.getClient();
    try {
      await client.subscriptions.cancel(subscriptionId, atCycleEnd);
    } catch (error) {
      // Razorpay refuses to cancel a subscription that isn't currently billing
      // ("no billing cycle is going on", "already cancelled", …). Decide from
      // its ACTUAL status, not the message: if it can never charge again, the
      // user's goal is already met and we must not block their cancellation.
      // Anything else propagates — marking it cancelled while the mandate is
      // still live would keep charging a customer who thinks they cancelled.
      const description =
        (error as { error?: { description?: string } })?.error?.description ??
        (error as Error)?.message;
      try {
        const current = await client.subscriptions.fetch(subscriptionId);
        const status = String(current.status);
        if (NON_CHARGING_SUBSCRIPTION_STATES.includes(status)) {
          logger.warn('Razorpay subscription already inactive — treating cancel as done', {
            subscriptionId,
            status,
            description,
          });
          return;
        }
      } catch (fetchError) {
        logger.error('Could not read Razorpay subscription state after cancel failure', {
          subscriptionId,
          error: (fetchError as Error).message,
        });
      }
      throw this.gatewayError(error, 'subscription cancellation', 'could not cancel it');
    }
  }

  /**
   * Verify a subscription checkout signature. NOTE the operand order differs
   * from one-time orders: HMAC-SHA256(payment_id|subscription_id).
   */
  verifySubscriptionSignature(paymentId: string, subscriptionId: string, signature: string): void {
    if (!this.isConfigured()) {
      throw new BadRequestError('Online payment is not configured');
    }
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${paymentId}|${subscriptionId}`)
      .digest('hex');
    const valid =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!valid) {
      throw new BadRequestError(
        "We couldn't confirm this payment. If money left your account, contact support and we'll make it right."
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
      throw new BadRequestError(
        "We couldn't confirm this payment. If money left your account, contact support and we'll make it right."
      );
    }
  }
}

export const paymentService = new PaymentService();
