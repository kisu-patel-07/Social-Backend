import { Types } from 'mongoose';
import { MessageType, Platform } from '../constants';
import {
  analyticsRepository,
  automationRepository,
  conversationRepository,
  keywordRepository,
  leadRepository,
  messageRepository,
  socialAccountRepository,
  workspaceRepository,
} from '../repositories';
import { AnalyticsMetric } from '../repositories/analytics.repository';
import { daysAgo, endOfDay, startOfDay, toDateKey } from '../utils/date';

export interface DashboardSummary {
  connectedAccounts: number;
  activeAutomations: number;
  totalLeads: number;
  unreadConversations: number;
  todayMessages: number;
  todayComments: number;
  monthly: {
    commentsTriggered: number;
    dmSent: number;
    newLeads: number;
    messagesReceived: number;
  };
}

export interface AnalyticsOverview {
  connectedAccounts: number;
  commentsTriggered: number;
  dmSent: number;
  newLeads: number;
  topKeyword: { value: string; matchCount: number } | null;
  mostActivePlatform: Platform | null;
  daily: Array<{ date: string } & Record<AnalyticsMetric, number>>;
}

class AnalyticsService {
  /** Record an analytics event by incrementing the relevant daily bucket. */
  track(
    workspaceId: string,
    metric: AnalyticsMetric,
    platform?: Platform,
    when: Date = new Date()
  ): Promise<void> {
    return analyticsRepository.increment(workspaceId, metric, when, platform);
  }

  /** Build the dashboard summary cards. */
  async getDashboardSummary(workspaceId: string): Promise<DashboardSummary> {
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const monthStart = startOfDay(daysAgo(30));

    const [
      connectedAccounts,
      activeAutomations,
      totalLeads,
      unreadConversations,
      todayMessages,
      todayComments,
      monthly,
    ] = await Promise.all([
      socialAccountRepository.countActiveByWorkspace(workspaceId),
      automationRepository.countActiveByWorkspace(workspaceId),
      leadRepository.countByWorkspace(workspaceId),
      conversationRepository.countUnreadByWorkspace(workspaceId),
      messageRepository.countByTypeBetween(
        workspaceId,
        MessageType.DIRECT_MESSAGE,
        todayStart,
        todayEnd
      ),
      messageRepository.countByTypeBetween(workspaceId, MessageType.COMMENT, todayStart, todayEnd),
      analyticsRepository.sumBetween(workspaceId, monthStart, todayEnd),
    ]);

    return {
      connectedAccounts,
      activeAutomations,
      totalLeads,
      unreadConversations,
      todayMessages,
      todayComments,
      monthly,
    };
  }

  /** Build the analytics page overview (range in days, default 30). */
  async getOverview(workspaceId: string, rangeDays = 30): Promise<AnalyticsOverview> {
    const end = endOfDay(new Date());
    const start = startOfDay(daysAgo(rangeDays));

    const [connectedAccounts, sums, series, topKeywordDoc, platformAgg] = await Promise.all([
      socialAccountRepository.countActiveByWorkspace(workspaceId),
      analyticsRepository.sumBetween(workspaceId, start, end),
      analyticsRepository.getDailySeries(workspaceId, start, end),
      keywordRepository.find({ workspace: workspaceId }, undefined, {
        sort: { matchCount: -1 },
        limit: 1,
      }),
      this.computeMostActivePlatform(workspaceId, start, end),
    ]);

    // Collapse multiple platform buckets per day into a single daily row.
    const dailyMap = new Map<string, Record<AnalyticsMetric, number>>();
    for (const row of series) {
      const key = row.dateKey;
      const existing =
        dailyMap.get(key) ??
        ({ commentsTriggered: 0, dmSent: 0, newLeads: 0, messagesReceived: 0 } as Record<
          AnalyticsMetric,
          number
        >);
      existing.commentsTriggered += row.commentsTriggered;
      existing.dmSent += row.dmSent;
      existing.newLeads += row.newLeads;
      existing.messagesReceived += row.messagesReceived;
      dailyMap.set(key, existing);
    }

    const daily = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, metrics]) => ({ date, ...metrics }));

    return {
      connectedAccounts,
      commentsTriggered: sums.commentsTriggered,
      dmSent: sums.dmSent,
      newLeads: sums.newLeads,
      topKeyword: topKeywordDoc[0]
        ? { value: topKeywordDoc[0].value, matchCount: topKeywordDoc[0].matchCount }
        : null,
      mostActivePlatform: platformAgg,
      daily,
    };
  }

  private async computeMostActivePlatform(
    workspaceId: string,
    start: Date,
    end: Date
  ): Promise<Platform | null> {
    const rows = await analyticsRepository.aggregate<{ _id: Platform; total: number }>([
      {
        $match: {
          workspace: new Types.ObjectId(workspaceId),
          date: { $gte: start, $lte: end },
          platform: { $ne: null },
        },
      },
      {
        $group: {
          _id: '$platform',
          total: { $sum: { $add: ['$commentsTriggered', '$dmSent', '$messagesReceived'] } },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 1 },
    ]);
    return rows[0]?._id ?? null;
  }

  /** Refresh the denormalized counters stored on the workspace document. */
  async refreshWorkspaceStats(workspaceId: string): Promise<void> {
    const [connectedAccounts, activeAutomations, totalLeads] = await Promise.all([
      socialAccountRepository.countActiveByWorkspace(workspaceId),
      automationRepository.countActiveByWorkspace(workspaceId),
      leadRepository.countByWorkspace(workspaceId),
    ]);
    await workspaceRepository.updateById(workspaceId, {
      'stats.connectedAccounts': connectedAccounts,
      'stats.activeAutomations': activeAutomations,
      'stats.totalLeads': totalLeads,
    });
  }

  /** Convenience: today's date key (for callers that need bucket alignment). */
  todayKey(): string {
    return toDateKey(new Date());
  }
}

export const analyticsService = new AnalyticsService();
