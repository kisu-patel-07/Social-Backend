import { connectDatabase, disconnectDatabase } from '../config/database';
import { logger } from '../config/logger';
import { MessageDirection, MessageType } from '../constants';
import { ConversationModel } from '../models/conversation.model';
import { MessageModel } from '../models/message.model';

/**
 * One-off backfill: link automation-sent DMs to their conversation.
 *
 * Before this fix, comment-to-DM automations recorded the outbound DM before
 * the conversation existed and never linked the two, so the inbox thread
 * rendered empty even though the list preview (read from the conversation's
 * lastMessagePreview) had text. This walks every orphaned DM and attaches it
 * to the conversation for the same social account + participant.
 *
 * Idempotent — safe to run multiple times.
 *
 * Run with: npx ts-node src/scripts/backfillMessageConversations.ts
 */
async function run(): Promise<void> {
  await connectDatabase();

  // Direct messages with no conversation reference (the automation-sent DMs).
  const orphaned = await MessageModel.find({
    type: MessageType.DIRECT_MESSAGE,
    conversation: { $in: [null, undefined] },
  }).exec();

  logger.info('Backfill: found orphaned DMs', { count: orphaned.length });

  let linked = 0;
  let unmatched = 0;

  for (const message of orphaned) {
    // Outbound DMs are addressed to the participant (toId); inbound to us (fromId).
    const participantId =
      message.direction === MessageDirection.OUTBOUND ? message.toId : message.fromId;
    if (!participantId) {
      unmatched += 1;
      continue;
    }

    const conversation = await ConversationModel.findOne({
      socialAccount: message.socialAccount,
      participantId,
    }).exec();

    if (!conversation) {
      unmatched += 1;
      continue;
    }

    await MessageModel.updateOne(
      { _id: message._id },
      { $set: { conversation: conversation._id } }
    ).exec();
    linked += 1;
  }

  logger.info('Backfill complete', { linked, unmatched });
  await disconnectDatabase();
}

run().catch((error) => {
  logger.error('Backfill failed', { error });
  process.exit(1);
});
