import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * AI auto-reply generator. Talks to any OpenAI-compatible chat-completions
 * endpoint; the default env config targets Google Gemini's free tier, and
 * Groq's free tier works by swapping AI_BASE_URL/AI_MODEL — so the feature
 * can run at zero cost. Fails closed: any error returns null and the DM
 * simply goes unanswered by AI (a human can reply from the inbox).
 */
export interface AiProviderOverrides {
  /** Workspace's own key (BYOK) — used instead of the platform key. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

class AiReplyService {
  /** Whether the platform itself has a key configured. */
  isConfigured(): boolean {
    return Boolean(env.AI_API_KEY);
  }

  private systemPrompt(businessContext: string): string {
    return [
      'You are a friendly, concise customer-support assistant replying inside an Instagram/Facebook direct-message thread on behalf of a business.',
      'Rules:',
      '- Answer ONLY using the business information below. If the answer is not covered there, say you will pass the question to the team and they will reply soon.',
      '- Keep replies under 500 characters, warm and human, in the same language the customer wrote in.',
      '- Never invent prices, links, or policies. Never mention that you are an AI unless asked directly.',
      '- No markdown formatting — this is a plain-text DM.',
      '',
      'Business information:',
      businessContext,
    ].join('\n');
  }

  /**
   * Generate a reply to an inbound DM, or null when unavailable. A workspace
   * with its own key (BYOK) runs on its own provider/expense; otherwise the
   * platform-level env config is used.
   */
  async generateReply(
    businessContext: string,
    userMessage: string,
    overrides: AiProviderOverrides = {}
  ): Promise<string | null> {
    const apiKey = overrides.apiKey || env.AI_API_KEY;
    const baseUrl = (overrides.apiKey ? overrides.baseUrl : '') || env.AI_BASE_URL;
    const model = (overrides.apiKey ? overrides.model : '') || env.AI_MODEL;
    if (!apiKey || !businessContext.trim() || !userMessage.trim()) return null;

    try {
      const response = await axios.post(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          model,
          max_tokens: 300,
          messages: [
            { role: 'system', content: this.systemPrompt(businessContext) },
            { role: 'user', content: userMessage.slice(0, 2000) },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      const text: unknown = response.data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) return null;
      // Meta DMs cap at 1000 chars; stay well under it.
      return text.trim().slice(0, 950);
    } catch (error) {
      const detail = axios.isAxiosError(error)
        ? (error.response?.data ?? error.message)
        : (error as Error).message;
      logger.warn('AI reply generation failed — skipping AI response', { detail });
      return null;
    }
  }
}

export const aiReplyService = new AiReplyService();
