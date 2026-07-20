import crypto from 'crypto';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { MessageDirection, MessageType } from '../constants';
import { messageRepository } from '../repositories';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

interface Participant {
  fromId: string;
  username?: string;
  comments: number;
  sampleText?: string;
}

/** Cryptographically fair shuffle-pick of N distinct participants. */
function pickRandom<T>(pool: T[], count: number): T[] {
  const copy = [...pool];
  const winners: T[] = [];
  while (copy.length > 0 && winners.length < count) {
    const index = crypto.randomInt(copy.length);
    winners.push(copy.splice(index, 1)[0]);
  }
  return winners;
}

export const giveawayController = {
  /** Posts that have received comments, newest activity first. */
  posts: asyncHandler(async (req: Request, res: Response) => {
    const match: Record<string, unknown> = {
      workspace: new Types.ObjectId(req.user!.workspaceId),
      type: MessageType.COMMENT,
      direction: MessageDirection.INBOUND,
      postId: { $exists: true, $nin: [null, ''] },
    };
    if (req.query.socialAccountId) {
      match.socialAccount = new Types.ObjectId(String(req.query.socialAccountId));
    }

    const posts = await messageRepository.aggregate<{
      _id: string;
      comments: number;
      participants: number;
      lastCommentAt: Date;
    }>([
      { $match: match },
      {
        $group: {
          _id: '$postId',
          comments: { $sum: 1 },
          uniq: { $addToSet: '$fromId' },
          lastCommentAt: { $max: '$createdAt' },
        },
      },
      { $project: { comments: 1, participants: { $size: '$uniq' }, lastCommentAt: 1 } },
      { $sort: { lastCommentAt: -1 } },
      { $limit: 50 },
    ]);

    sendSuccess(
      res,
      posts.map((p) => ({
        postId: p._id,
        comments: p.comments,
        participants: p.participants,
        lastCommentAt: p.lastCommentAt,
      }))
    );
  }),

  /** Pick random winner(s) among the commenters of a post. */
  pick: asyncHandler(async (req: Request, res: Response) => {
    const { postId, socialAccountId, keyword } = req.body as {
      postId: string;
      socialAccountId?: string;
      keyword?: string;
    };
    const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 10);

    const match: Record<string, unknown> = {
      workspace: new Types.ObjectId(req.user!.workspaceId),
      type: MessageType.COMMENT,
      direction: MessageDirection.INBOUND,
      postId,
      fromId: { $exists: true, $nin: [null, ''] },
    };
    if (socialAccountId) match.socialAccount = new Types.ObjectId(socialAccountId);
    if (keyword?.trim()) match.text = { $regex: keyword.trim(), $options: 'i' };

    const participants = await messageRepository.aggregate<{
      _id: string;
      username?: string;
      comments: number;
      sampleText?: string;
    }>([
      { $match: match },
      {
        $group: {
          _id: '$fromId',
          username: { $first: '$fromUsername' },
          comments: { $sum: 1 },
          sampleText: { $last: '$text' },
        },
      },
    ]);

    const pool: Participant[] = participants.map((p) => ({
      fromId: p._id,
      username: p.username,
      comments: p.comments,
      sampleText: p.sampleText,
    }));
    const winners = pickRandom(pool, count);

    sendSuccess(res, { totalParticipants: pool.length, winners });
  }),
};
