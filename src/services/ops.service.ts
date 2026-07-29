import { ActivityAction } from '../constants';
import { logger } from '../config/logger';
import { IWebhookEvent } from '../models/webhookEvent.model';
import { jobRunRepository, webhookEventRepository } from '../repositories';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { BadRequestError, NotFoundError } from '../utils/AppError';
import { activityService } from './activity.service';
import { subscriptionService } from './subscription.service';
import { webhookService } from './webhook.service';

interface WebhookEventFilters extends PaginationOptions {
  source?: 'meta' | 'razorpay';
  outcome?: IWebhookEvent['outcome'];
}

/**
 * Operational visibility: the webhook debug trail and scheduled-job runs the
 * admin Health/Webhooks pages read. Recording is always best-effort — an
 * observability failure must never break the thing being observed.
 */
class OpsService {
  /** Record one webhook delivery. Never throws. */
  async recordWebhookEvent(params: {
    source: 'meta' | 'razorpay';
    event: string;
    outcome: IWebhookEvent['outcome'];
    payload?: unknown;
    error?: string;
  }): Promise<void> {
    try {
      await webhookEventRepository.create({
        source: params.source,
        event: params.event.slice(0, 200),
        outcome: params.outcome,
        payload: params.payload,
        error: params.error?.slice(0, 1000),
      });
    } catch (err) {
      logger.warn('Failed to record webhook event', {
        source: params.source,
        error: (err as Error).message,
      });
    }
  }

  listWebhookEvents(filters: WebhookEventFilters): Promise<PaginatedResult<IWebhookEvent>> {
    const query: Record<string, unknown> = {};
    if (filters.source) query.source = filters.source;
    if (filters.outcome) query.outcome = filters.outcome;
    return webhookEventRepository.paginate(query, filters);
  }

  /**
   * Re-run a stored delivery through the same pipeline it originally hit.
   * Safe because both pipelines are idempotent (Meta events dedupe on
   * externalId/dedupeKey; Razorpay activation dedupes on providerPaymentId).
   */
  async reprocessWebhookEvent(actor: AuthUser, id: string): Promise<IWebhookEvent> {
    const event = await webhookEventRepository.findById(id);
    if (!event) throw new NotFoundError('Webhook event not found');
    if (!event.payload) {
      throw new BadRequestError(
        'This delivery has no stored payload, so it cannot be re-processed.'
      );
    }

    let outcome: IWebhookEvent['outcome'] = 'processed';
    let error: string | undefined;
    try {
      if (event.source === 'meta') {
        await webhookService.process(event.payload);
      } else {
        await subscriptionService.handleRazorpayWebhook(
          event.payload as Parameters<typeof subscriptionService.handleRazorpayWebhook>[0]
        );
      }
    } catch (err) {
      outcome = 'failed';
      error = (err as Error).message;
    }

    const updated = await webhookEventRepository.updateById(event._id, {
      $set: {
        outcome,
        reprocessedAt: new Date(),
        reprocessedBy: actor.id,
        ...(error ? { error: error.slice(0, 1000) } : {}),
      },
      ...(error ? {} : { $unset: { error: '' } }),
    });

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_WEBHOOK_REPROCESSED,
      description: `${actor.email} re-processed a ${event.source} webhook (${event.event}) → ${outcome}`,
      entityType: 'WebhookEvent',
      entityId: event._id,
    });

    return updated ?? event;
  }

  /** Time a scheduled job and persist its outcome. Never throws past the job. */
  async recordJobRun<T>(job: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await fn();
      await this.saveRun(job, true, this.summarize(result), Date.now() - startedAt);
      return result;
    } catch (err) {
      await this.saveRun(job, false, (err as Error).message, Date.now() - startedAt);
      throw err;
    }
  }

  private summarize(result: unknown): string {
    if (result === undefined || result === null) return 'done';
    if (typeof result === 'object') return JSON.stringify(result).slice(0, 500);
    return String(result).slice(0, 500);
  }

  private async saveRun(
    job: string,
    ok: boolean,
    summary: string,
    durationMs: number
  ): Promise<void> {
    try {
      await jobRunRepository.create({ job, ok, summary: summary.slice(0, 500), durationMs });
    } catch (err) {
      logger.warn('Failed to record job run', { job, error: (err as Error).message });
    }
  }
}

export const opsService = new OpsService();
