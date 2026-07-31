/**
 * Diagnostic: recent automated outbound sends and why they failed.
 *
 * Meta silently drops unsupported message features (e.g. templates on a
 * private reply) or rejects them outright — this prints the raw error stored on
 * each failed message so a "the DM arrived but the buttons didn't" report can
 * be traced to the actual Graph API response.
 *
 * Usage: npm run studio:check
 */
import { connectDatabase } from '../config/database';
import mongoose from 'mongoose';
import { MessageModel } from '../models/message.model';
import { FlowRunModel } from '../models/flowRun.model';

async function main(): Promise<void> {
  await connectDatabase();

  const messages = await MessageModel.find({ isAutomated: true })
    .sort({ createdAt: -1 })
    .limit(25)
    .lean()
    .exec();

  console.log(`\n=== Last ${messages.length} automated sends ===`);
  for (const m of messages) {
    const when = new Date(m.createdAt as unknown as string).toISOString();
    console.log(
      `\n[${when}] ${m.type} → ${m.toId ?? '?'}  status=${m.status}` +
        `\n  text: ${JSON.stringify((m.text ?? '').slice(0, 90))}` +
        (m.error ? `\n  ERROR: ${m.error}` : '')
    );
  }

  const runs = await FlowRunModel.find().sort({ updatedAt: -1 }).limit(15).lean().exec();
  console.log(`\n\n=== Last ${runs.length} flow runs ===`);
  for (const r of runs) {
    console.log(
      `[${new Date(r.updatedAt as unknown as string).toISOString()}] participant=${r.participantId}` +
        ` step=${r.step} email=${r.email ?? '-'} clicked=${r.linkClicked}` +
        ` linkSentAt=${r.linkSentAt ? new Date(r.linkSentAt).toISOString() : '-'}`
    );
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
