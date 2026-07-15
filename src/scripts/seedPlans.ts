import { BillingInterval } from '../constants';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { logger } from '../config/logger';
import { PlanModel } from '../models/plan.model';

/**
 * Seed the default subscription plans. Idempotent — upserts by plan code.
 * Run with: npx ts-node src/scripts/seedPlans.ts
 */
const plans = [
  {
    code: 'free',
    name: 'Free',
    description: 'Get started with comment-to-DM automation.',
    priceAmount: 0,
    currency: 'USD',
    interval: BillingInterval.MONTHLY,
    limits: { connectedAccounts: 1, automations: 2, monthlyMessages: 200, teamMembers: 1 },
    entitlements: { studio: false, csvExport: false },
    features: ['1 connected account', '2 automations', 'Unified inbox', 'Basic analytics'],
    sortOrder: 0,
  },
  {
    code: 'starter',
    name: 'Starter',
    description: 'For growing creators and small businesses.',
    priceAmount: 1900,
    currency: 'USD',
    interval: BillingInterval.MONTHLY,
    limits: { connectedAccounts: 3, automations: 15, monthlyMessages: 5000, teamMembers: 1 },
    entitlements: { studio: true, csvExport: true },
    features: ['3 connected accounts', '15 automations', 'CSV export', 'Email notifications'],
    sortOrder: 1,
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'For agencies and high-volume accounts.',
    priceAmount: 4900,
    currency: 'USD',
    interval: BillingInterval.MONTHLY,
    limits: {
      connectedAccounts: 10,
      automations: -1,
      monthlyMessages: 50000,
      teamMembers: 1,
    },
    entitlements: { studio: true, csvExport: true },
    features: [
      '10 connected accounts',
      'Unlimited automations',
      'Advanced analytics',
      'Priority support',
    ],
    sortOrder: 2,
  },
];

async function run(): Promise<void> {
  await connectDatabase();
  for (const plan of plans) {
    await PlanModel.updateOne({ code: plan.code }, { $set: plan }, { upsert: true });
    logger.info(`Seeded plan: ${plan.code}`);
  }
  await disconnectDatabase();
  logger.info('✅ Plan seeding complete');
}

run().catch((error) => {
  logger.error('Plan seeding failed', { error });
  process.exit(1);
});
