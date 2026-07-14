import { connectDatabase, disconnectDatabase } from '../config/database';
import { logger } from '../config/logger';
import { UserModel } from '../models/user.model';

/**
 * Grant (or revoke) the platform super-admin flag for a user.
 * Deliberately CLI-only — there is no API that can set isSuperAdmin.
 *
 * Usage:
 *   npm run admin:promote -- you@example.com
 *   npm run admin:promote -- you@example.com --revoke
 */
async function run(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  const revoke = process.argv.includes('--revoke');

  if (!email || email.startsWith('--')) {
    logger.error('Usage: npm run admin:promote -- <email> [--revoke]');
    process.exit(1);
  }

  await connectDatabase();
  const user = await UserModel.findOneAndUpdate(
    { email },
    { $set: { isSuperAdmin: !revoke } },
    { new: true }
  );
  await disconnectDatabase();

  if (!user) {
    logger.error(`No user found with email ${email}`);
    process.exit(1);
  }
  logger.info(
    `✅ ${user.email} is ${revoke ? 'no longer' : 'now'} a super admin${
      !revoke && !user.isEmailVerified ? ' (note: email not verified — verify before logging in)' : ''
    }`
  );
}

run().catch((error) => {
  logger.error('Promotion failed', { error });
  process.exit(1);
});
