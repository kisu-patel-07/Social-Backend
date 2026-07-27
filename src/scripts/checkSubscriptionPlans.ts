import { connectDatabase, disconnectDatabase } from '../config/database';
import { logger } from '../config/logger';
import { PlanModel } from '../models/plan.model';
import { SubscriptionModel } from '../models/subscription.model';
// Registers the Workspace schema so `.populate('workspace')` resolves.
import '../models/workspace.model';

/**
 * Data-integrity check: find subscriptions whose `plan` reference no longer
 * resolves to a Plan document. At runtime such subscriptions SILENTLY fall back
 * to Free entitlements (the "paid Pro but got Regular features" bug), so this
 * lists them for manual repair via Admin → Billing → edit the subscription's
 * plan. Most commonly caused by a subscription copied across databases pointing
 * at a plan _id that was never seeded in the target database.
 *
 * Read-only — it changes nothing. Run against the intended environment, e.g.:
 *   NODE_ENV=production npm run subs:check
 */
async function run(): Promise<void> {
  await connectDatabase();
  try {
    const planIds = new Set((await PlanModel.find({}, '_id').lean()).map((p) => String(p._id)));

    const subs = await SubscriptionModel.find({}, '_id workspace plan status currentPeriodEnd')
      .populate('workspace', 'name')
      .lean();

    const dangling = subs.filter((s) => !s.plan || !planIds.has(String(s.plan)));

    logger.info(`Checked ${subs.length} subscription(s) against ${planIds.size} plan(s).`);

    if (dangling.length === 0) {
      logger.info('✅ All subscriptions reference a valid plan.');
      return;
    }

    logger.warn(
      `⚠ ${dangling.length} subscription(s) reference a MISSING plan and are being served Free:`
    );
    for (const s of dangling) {
      const workspaceName = (s.workspace as { name?: string } | null)?.name ?? '(unknown)';
      // eslint-disable-next-line no-console
      console.log(
        `  - subscription ${String(s._id)} | workspace "${workspaceName}" | status ${s.status} | danglingPlanId ${String(s.plan ?? 'none')}`
      );
    }
    logger.warn('Fix each in Admin → Billing → edit the subscription → set the correct plan.');
  } finally {
    await disconnectDatabase();
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('subs:check failed', { error: (error as Error).message });
    process.exit(1);
  });
