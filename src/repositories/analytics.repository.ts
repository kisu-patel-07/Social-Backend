import { Types } from 'mongoose';
import { AnalyticsDailyModel, IAnalyticsDaily } from '../models/analytics.model';
import { Platform } from '../constants';
import { toDateKeyUTC } from '../utils/date';
import { BaseRepository } from './base.repository';

export type AnalyticsMetric = 'commentsTriggered' | 'dmSent' | 'newLeads' | 'messagesReceived';

class AnalyticsRepository extends BaseRepository<IAnalyticsDaily> {
  constructor() {
    super(AnalyticsDailyModel);
  }

  /**
   * Atomically increment a daily metric bucket, creating it if absent.
   * One bucket per workspace+date+platform.
   */
  async increment(
    workspaceId: string,
    metric: AnalyticsMetric,
    when: Date,
    platform?: Platform,
    by = 1
  ): Promise<void> {
    const dateKey = toDateKeyUTC(when);
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    await this.model
      .updateOne(
        { workspace: workspaceId, dateKey, platform: platform ?? null },
        {
          $inc: { [metric]: by },
          $setOnInsert: { date },
        },
        { upsert: true }
      )
      .exec();
  }

  /** Daily series between two dates for charting. */
  getDailySeries(workspaceId: string, start: Date, end: Date): Promise<IAnalyticsDaily[]> {
    return this.find({ workspace: workspaceId, date: { $gte: start, $lte: end } }, undefined, {
      sort: { date: 1 },
    });
  }

  /** Sum each metric across a date range for a workspace. */
  async sumBetween(
    workspaceId: string,
    start: Date,
    end: Date
  ): Promise<Record<AnalyticsMetric, number>> {
    const [result] = await this.aggregate<Record<AnalyticsMetric, number>>([
      {
        $match: {
          workspace: new Types.ObjectId(workspaceId),
          date: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id: null,
          commentsTriggered: { $sum: '$commentsTriggered' },
          dmSent: { $sum: '$dmSent' },
          newLeads: { $sum: '$newLeads' },
          messagesReceived: { $sum: '$messagesReceived' },
        },
      },
    ]);
    return {
      commentsTriggered: result?.commentsTriggered ?? 0,
      dmSent: result?.dmSent ?? 0,
      newLeads: result?.newLeads ?? 0,
      messagesReceived: result?.messagesReceived ?? 0,
    };
  }
}

export const analyticsRepository = new AnalyticsRepository();
