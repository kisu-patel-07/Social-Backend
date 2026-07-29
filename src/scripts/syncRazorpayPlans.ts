import { connectDatabase, disconnectDatabase } from '../config/database';
import { logger } from '../config/logger';
import { BillingInterval } from '../constants';
import { PlanModel } from '../models/plan.model';
import { paymentService } from '../services/payment.service';

/**
 * Create the Razorpay-side plan for every paid plan that doesn't have one yet,
 * and store its id on the local plan as `razorpayPlanId`.
 *
 * A plan only becomes sellable as an AUTO-RENEWING subscription once it has
 * that id; until then the billing page falls back to a one-time payment per
 * period. Safe to re-run — plans that already have an id are skipped.
 *
 *   npm run razorpay:sync-plans                  # against .env.development
 *   NODE_ENV=production npm run razorpay:sync-plans
 *
 * Razorpay plans are immutable: to change a price, create a NEW local plan
 * (existing subscribers keep billing at the price they signed up for, which is
 * how recurring billing is supposed to work).
 */

/** Map our billing interval onto Razorpay's period + interval pair. */
function razorpayCycle(plan: { interval: BillingInterval; durationDays?: number }): {
  period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
} {
  if (plan.interval === BillingInterval.YEARLY) return { period: 'yearly', interval: 1 };
  if (plan.interval === BillingInterval.DAYS) {
    const days = plan.durationDays ?? 30;
    // Razorpay bills "every N days" via period=daily + interval=N.
    return { period: 'daily', interval: Math.max(1, Math.min(365, days)) };
  }
  return { period: 'monthly', interval: 1 };
}

async function run(): Promise<void> {
  if (!paymentService.isConfigured()) {
    logger.error(
      'Razorpay keys are not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET first.'
    );
    process.exitCode = 1;
    return;
  }

  await connectDatabase();
  try {
    const plans = await PlanModel.find({ priceAmount: { $gt: 0 } }).sort({ sortOrder: 1 });
    if (!plans.length) {
      logger.info('No paid plans found — nothing to sync.');
      return;
    }

    let created = 0;
    let skipped = 0;

    for (const plan of plans) {
      if (plan.razorpayPlanId) {
        logger.info(`skip   ${plan.code} — already linked (${plan.razorpayPlanId})`);
        skipped += 1;
        continue;
      }

      const cycle = razorpayCycle(plan);
      try {
        const { planId } = await paymentService.createPlan({
          period: cycle.period,
          interval: cycle.interval,
          name: plan.name,
          description: plan.description,
          amount: plan.priceAmount,
          currency: plan.currency || 'INR',
          notes: { app: process.env.APP_ID ?? 'socialdm', planCode: plan.code },
        });
        await PlanModel.updateOne({ _id: plan._id }, { $set: { razorpayPlanId: planId } });
        logger.info(
          `create ${plan.code} — ${planId} (every ${cycle.interval} ${cycle.period.replace('ly', '')})`
        );
        created += 1;
      } catch (error) {
        // One bad plan must not stop the rest.
        logger.error(`fail   ${plan.code} — ${(error as Error).message}`);
        process.exitCode = 1;
      }
    }

    logger.info(`Done. ${created} created, ${skipped} already linked.`);
    if (created > 0) {
      logger.info(
        'Auto-renewal is now available for those plans. Make sure the Razorpay webhook is set up ' +
          'for subscription.charged, subscription.cancelled, subscription.halted and subscription.pending.'
      );
    }
  } finally {
    await disconnectDatabase();
  }
}

run().catch((error) => {
  logger.error('Razorpay plan sync failed', { error: (error as Error).message });
  process.exit(1);
});
