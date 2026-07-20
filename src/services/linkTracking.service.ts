import crypto from 'crypto';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { ITrackedLink, TrackedLinkModel } from '../models/trackedLink.model';

const URL_REGEX = /https?:\/\/[^\s<>"')]+/g;
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateSlug(length = 7): string {
  let slug = '';
  for (let i = 0; i < length; i++) {
    slug += SLUG_ALPHABET[crypto.randomInt(SLUG_ALPHABET.length)];
  }
  return slug;
}

interface LinkSource {
  workspaceId: string;
  automationId?: string;
  studioAutomationId?: string;
}

/**
 * Wraps outbound DM links in short /r/:slug redirects so automations can
 * report clicks. Fails open: any error returns the original text untouched —
 * tracking must never block a message send.
 */
class LinkTrackingService {
  private trackingUrl(slug: string): string {
    return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/r/${slug}`;
  }

  /** Get-or-create the tracked link for this (source, url) pair. */
  private async getOrCreate(source: LinkSource, originalUrl: string): Promise<ITrackedLink> {
    const filter = {
      workspace: new Types.ObjectId(source.workspaceId),
      automation: source.automationId ? new Types.ObjectId(source.automationId) : undefined,
      studioAutomation: source.studioAutomationId
        ? new Types.ObjectId(source.studioAutomationId)
        : undefined,
      originalUrl,
    };
    const existing = await TrackedLinkModel.findOne(filter).exec();
    if (existing) return existing;
    return TrackedLinkModel.create({ ...filter, slug: generateSlug() });
  }

  /** Replace every URL in a DM text with its tracked redirect. */
  async wrapText(source: LinkSource, text: string): Promise<string> {
    try {
      const urls = [...new Set(text.match(URL_REGEX) ?? [])];
      if (urls.length === 0) return text;
      let wrapped = text;
      for (const url of urls) {
        // Never double-wrap our own redirect links.
        if (url.startsWith(env.PUBLIC_API_URL)) continue;
        const link = await this.getOrCreate(source, url);
        wrapped = wrapped.split(url).join(this.trackingUrl(link.slug));
      }
      return wrapped;
    } catch (error) {
      logger.warn('Link tracking wrap failed — sending original text', {
        error: (error as Error).message,
      });
      return text;
    }
  }

  /** Wrap a single URL (Studio DM buttons). */
  async wrapUrl(source: LinkSource, url: string): Promise<string> {
    try {
      if (!/^https?:\/\//.test(url) || url.startsWith(env.PUBLIC_API_URL)) return url;
      const link = await this.getOrCreate(source, url);
      return this.trackingUrl(link.slug);
    } catch {
      return url;
    }
  }

  /** Resolve a slug, count the click, and return the destination (or null). */
  async resolveClick(slug: string): Promise<string | null> {
    const link = await TrackedLinkModel.findOneAndUpdate(
      { slug },
      { $inc: { clicks: 1 }, $set: { lastClickedAt: new Date() } }
    ).exec();
    return link?.originalUrl ?? null;
  }

  /** Click totals for a workspace, grouped per automation. */
  async clickStats(workspaceId: string): Promise<{
    total: number;
    byAutomation: Record<string, number>;
    byStudioAutomation: Record<string, number>;
  }> {
    const links = await TrackedLinkModel.find({
      workspace: new Types.ObjectId(workspaceId),
    }).exec();

    const byAutomation: Record<string, number> = {};
    const byStudioAutomation: Record<string, number> = {};
    let total = 0;
    for (const link of links) {
      total += link.clicks;
      if (link.automation) {
        const id = link.automation.toString();
        byAutomation[id] = (byAutomation[id] ?? 0) + link.clicks;
      }
      if (link.studioAutomation) {
        const id = link.studioAutomation.toString();
        byStudioAutomation[id] = (byStudioAutomation[id] ?? 0) + link.clicks;
      }
    }
    return { total, byAutomation, byStudioAutomation };
  }
}

export const linkTrackingService = new LinkTrackingService();
