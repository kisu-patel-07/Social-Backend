import { Types } from 'mongoose';
import { couponRepository, couponRedemptionRepository } from '../repositories';
import { ICoupon } from '../models/coupon.model';
import { IPlan } from '../models/plan.model';
import { CouponType } from '../constants';
import { BadRequestError } from '../utils/AppError';
import { logger } from '../config/logger';

/**
 * Razorpay will not accept an order below ₹1.00. Anything that lands under
 * this after a discount is treated as fully free and activated without a
 * gateway round-trip, instead of failing at Checkout with a gateway error.
 */
const MIN_GATEWAY_CHARGE = 100;

/** What a validated coupon does to a specific plan's price. */
export interface CouponQuote {
  couponId: string;
  code: string;
  type: CouponType;
  value: number;
  /** Amount taken off, in the smallest currency unit. */
  discountAmount: number;
  /** What the customer actually pays. 0 ⇒ activate free, no gateway. */
  finalAmount: number;
  originalAmount: number;
  currency: string;
  /** Human sentence for the UI, e.g. "20% off your first payment". */
  summary: string;
}

/**
 * Discount codes. Deliberately ONE-TIME: a coupon reduces the first payment
 * only and is never carried into a renewal, so a coupon checkout always uses
 * the one-time payment path rather than an auto-debit mandate.
 */
class CouponService {
  /**
   * Validate a code against a plan + workspace and price it. Throws friendly,
   * specific errors (expired / used / not for this plan) so the customer knows
   * what to do next. Called both when the code box is submitted and again at
   * checkout — never trust a client-supplied discount.
   */
  async quote(params: { code: string; plan: IPlan; workspaceId: string }): Promise<CouponQuote> {
    const { plan, workspaceId } = params;
    const code = params.code.trim().toUpperCase();
    if (!code) throw new BadRequestError('Enter a coupon code to apply it.');

    const coupon = await couponRepository.findByCode(code);
    if (!coupon || !coupon.isActive) {
      throw new BadRequestError(
        "That coupon code isn't valid. Check the spelling, or continue without it."
      );
    }
    if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
      throw new BadRequestError('This coupon has expired.');
    }
    if (coupon.maxRedemptions && coupon.redemptionCount >= coupon.maxRedemptions) {
      throw new BadRequestError('This coupon has already been fully claimed.');
    }
    if (coupon.plans.length && !coupon.plans.some((p) => p.toString() === plan._id.toString())) {
      throw new BadRequestError(`This coupon can't be used on the ${plan.name} plan.`);
    }
    if (plan.priceAmount <= 0) {
      throw new BadRequestError("This plan is already free — you don't need a coupon.");
    }

    const alreadyUsed = await couponRedemptionRepository.exists({
      coupon: coupon._id,
      workspace: new Types.ObjectId(workspaceId),
    });
    if (alreadyUsed) {
      throw new BadRequestError('You have already used this coupon.');
    }

    const currency = plan.currency || 'INR';
    if (coupon.type === CouponType.FLAT && coupon.currency && coupon.currency !== currency) {
      throw new BadRequestError(`This coupon only works on plans priced in ${coupon.currency}.`);
    }

    return this.price(coupon, plan, currency);
  }

  /** Pure pricing maths, shared by quote() and checkout. */
  private price(coupon: ICoupon, plan: IPlan, currency: string): CouponQuote {
    const originalAmount = plan.priceAmount;
    const rawDiscount =
      coupon.type === CouponType.PERCENT
        ? Math.round((originalAmount * coupon.value) / 100)
        : coupon.value;
    const discountAmount = Math.min(rawDiscount, originalAmount);
    let finalAmount = originalAmount - discountAmount;
    // Below the gateway minimum there is nothing to collect — make it free
    // rather than sending Razorpay an order it will reject.
    if (finalAmount > 0 && finalAmount < MIN_GATEWAY_CHARGE) finalAmount = 0;

    const summary =
      coupon.type === CouponType.PERCENT
        ? `${coupon.value}% off your first payment`
        : `${(coupon.value / 100).toFixed(2)} ${currency} off your first payment`;

    return {
      couponId: coupon._id.toString(),
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      discountAmount: originalAmount - finalAmount,
      finalAmount,
      originalAmount,
      currency,
      summary,
    };
  }

  /**
   * Record that a workspace used a coupon. The unique (coupon, workspace)
   * index is the real guard — a duplicate means a concurrent checkout already
   * redeemed it, which we swallow so the payment is never lost over
   * double-counting a discount.
   */
  async redeem(params: {
    quote: CouponQuote;
    workspaceId: string;
    planId: Types.ObjectId;
    paymentId?: Types.ObjectId;
  }): Promise<boolean> {
    const { quote, workspaceId } = params;
    try {
      await couponRedemptionRepository.create({
        coupon: new Types.ObjectId(quote.couponId),
        workspace: new Types.ObjectId(workspaceId),
        plan: params.planId,
        payment: params.paymentId,
        amountDiscounted: quote.discountAmount,
        currency: quote.currency,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        logger.warn('Coupon already redeemed by this workspace — skipping double count', {
          code: quote.code,
          workspaceId,
        });
        return false;
      }
      throw error;
    }

    await couponRepository.updateById(quote.couponId, { $inc: { redemptionCount: 1 } });
    return true;
  }

  /**
   * Re-quote a coupon at activation time from the code stored on the order.
   * Returns null when the code no longer validates, so activation continues
   * at full price rather than failing after money has already been taken.
   */
  async quoteForActivation(params: {
    code?: string;
    plan: IPlan;
    workspaceId: string;
  }): Promise<CouponQuote | null> {
    if (!params.code) return null;
    try {
      return await this.quote({
        code: params.code,
        plan: params.plan,
        workspaceId: params.workspaceId,
      });
    } catch (error) {
      logger.warn('Coupon no longer valid at activation — recording payment without it', {
        code: params.code,
        workspaceId: params.workspaceId,
        reason: (error as Error).message,
      });
      return null;
    }
  }
}

export const couponService = new CouponService();
