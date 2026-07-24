import crypto from 'crypto';
import { env } from '../../config/env';
import { Platform } from '../../constants';
import { IncomingComment, IncomingMessage, IncomingPostback } from './meta.types';

/**
 * Verify the X-Hub-Signature-256 header Meta sends with every webhook POST.
 * Requires the raw (unparsed) request body. Returns false on any mismatch.
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  if (!signatureHeader || !env.META_APP_SECRET) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', env.META_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Verify the GET handshake during webhook subscription setup. */
export function verifyWebhookChallenge(
  mode?: string,
  token?: string,
  challenge?: string
): string | null {
  if (mode === 'subscribe' && token === env.META_WEBHOOK_VERIFY_TOKEN && challenge) {
    return challenge;
  }
  return null;
}

interface ParsedEvents {
  comments: IncomingComment[];
  messages: IncomingMessage[];
  postbacks: IncomingPostback[];
}

/**
 * Normalize a raw Meta webhook payload into our internal event shapes.
 * Handles both `object: page` (Facebook) and `object: instagram` payloads.
 */
export function parseWebhookPayload(payload: unknown): ParsedEvents {
  const comments: IncomingComment[] = [];
  const messages: IncomingMessage[] = [];
  const postbacks: IncomingPostback[] = [];

  const body = payload as {
    object?: string;
    entry?: Array<{
      id: string;
      time?: number;
      changes?: Array<{ field: string; value: Record<string, unknown> }>;
      messaging?: Array<Record<string, unknown>>;
    }>;
  };

  if (!body?.entry?.length) return { comments, messages, postbacks };

  const platform = body.object === 'instagram' ? Platform.INSTAGRAM : Platform.FACEBOOK;

  for (const entry of body.entry) {
    const accountExternalId = entry.id;

    // Comment / feed change events.
    for (const change of entry.changes ?? []) {
      if (change.field === 'comments' || change.field === 'feed') {
        const v = change.value as Record<string, any>;
        // For FB feed changes, only act on added comments.
        if (change.field === 'feed' && v.item !== 'comment') continue;
        if (change.field === 'feed' && v.verb && v.verb !== 'add') continue;

        const commentId = (v.comment_id || v.id) as string | undefined;
        const text = (v.message || v.text || '') as string;
        if (!commentId) continue;

        comments.push({
          platform,
          accountExternalId,
          commentId,
          postId: (v.post_id || v.media?.id || v.parent_id) as string | undefined,
          text,
          fromId: (v.from?.id || v.sender_id || '') as string,
          fromUsername: (v.from?.username || v.from?.name) as string | undefined,
          fromName: v.from?.name as string | undefined,
          createdTime: v.created_time ? new Date(Number(v.created_time) * 1000) : undefined,
        });
      }
    }

    // Direct message events (Messenger / IG messaging).
    for (const m of entry.messaging ?? []) {
      const msg = m as Record<string, any>;
      // Button-click (postback) events drive multi-step DM flows.
      if (msg.postback?.payload) {
        postbacks.push({
          platform,
          accountExternalId,
          fromId: (msg.sender?.id || '') as string,
          payload: msg.postback.payload as string,
          title: msg.postback.title as string | undefined,
          createdTime: msg.timestamp ? new Date(Number(msg.timestamp)) : undefined,
        });
        continue;
      }
      if (!msg.message?.mid) continue;
      messages.push({
        platform,
        accountExternalId,
        messageId: msg.message.mid as string,
        text: (msg.message.text || '') as string,
        fromId: (msg.sender?.id || '') as string,
        toId: (msg.recipient?.id || accountExternalId) as string,
        // Present when the DM is a reply to a story — identifies which story.
        replyToStoryId: (msg.message.reply_to?.story?.id as string | undefined) || undefined,
        // Story mentions arrive as a message with a story_mention attachment.
        isStoryMention: Array.isArray(msg.message.attachments)
          ? msg.message.attachments.some(
              (a: Record<string, any>) => a?.type === 'story_mention'
            )
          : undefined,
        createdTime: msg.timestamp ? new Date(Number(msg.timestamp)) : undefined,
      });
    }
  }

  return { comments, messages, postbacks };
}
