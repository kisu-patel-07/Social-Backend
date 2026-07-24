import { Types } from 'mongoose';
import {
  AutomationTrigger,
  MessageDirection,
  MessageStatus,
  MessageType,
  Platform,
} from '../constants';
import {
  analyticsRepository,
  automationRepository,
  conversationRepository,
  keywordRepository,
  leadRepository,
  messageRepository,
  socialAccountRepository,
  studioAutomationRepository,
  workspaceRepository,
} from '../repositories';
import { AnalyticsMetric } from '../repositories/analytics.repository';
import { linkTrackingService } from './linkTracking.service';
import { daysAgo, endOfDayUTC, startOfDayUTC, toDateKeyUTC } from '../utils/date';

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

export interface AutomationFunnelRow {
  id: string;
  name: string;
  /** Classic automation vs. Automation Studio. */
  kind: 'classic' | 'studio';
  platform: Platform;
  triggerType: AutomationTrigger;
  status: string;
  /** Times the automation fired in range (one DM attempt per trigger). */
  triggered: number;
  /** DMs that were actually delivered (status SENT). */
  dmSent: number;
  /** Tracked-link clicks attributed to this automation in range. */
  clicked: number;
  /** New leads this automation captured in range. */
  leads: number;
}

export interface AutomationFunnels {
  rangeDays: number;
  totals: Pick<AutomationFunnelRow, 'triggered' | 'dmSent' | 'clicked' | 'leads'>;
  rows: AutomationFunnelRow[];
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
    const todayStart = startOfDayUTC(now);
    const todayEnd = endOfDayUTC(now);
    const monthStart = startOfDayUTC(daysAgo(30));

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
    const end = endOfDayUTC(new Date());
    const start = startOfDayUTC(daysAgo(rangeDays));

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

  /**
   * Per-automation funnel: triggered -> DM delivered -> link clicked -> lead
   * captured, over the selected range. Covers classic and Studio automations.
   * Both engines stamp their own id on outbound DM messages' `automation`
   * field, so a single message aggregation serves both kinds.
   */
  async getAutomationFunnels(workspaceId: string, rangeDays = 30): Promise<AutomationFunnels> {
    const end = endOfDayUTC(new Date());
    const start = startOfDayUTC(daysAgo(rangeDays));
    const wsId = new Types.ObjectId(workspaceId);

    const [automations, studioAutomations, messageAgg, leadAgg, clicks] = await Promise.all([
      automationRepository.find(
        { workspace: workspaceId },
        { name: 1, platform: 1, triggerType: 1, status: 1 }
      ),
      studioAutomationRepository.find(
        { workspace: workspaceId },
        { name: 1, platform: 1, triggerType: 1, status: 1 }
      ),
      messageRepository.aggregate<{ _id: Types.ObjectId; triggered: number; dmSent: number }>([
        {
          $match: {
            workspace: wsId,
            direction: MessageDirection.OUTBOUND,
            type: MessageType.DIRECT_MESSAGE,
            isAutomated: true,
            automation: { $ne: null },
            createdAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: '$automation',
            triggered: { $sum: 1 },
            dmSent: { $sum: { $cond: [{ $eq: ['$status', MessageStatus.SENT] }, 1, 0] } },
          },
        },
      ]),
      leadRepository.aggregate<{
        _id: { automation?: Types.ObjectId; studioAutomation?: Types.ObjectId };
        leads: number;
      }>([
        {
          $match: {
            workspace: wsId,
            createdAt: { $gte: start, $lte: end },
            $or: [{ automation: { $ne: null } }, { studioAutomation: { $ne: null } }],
          },
        },
        {
          $group: {
            _id: { automation: '$automation', studioAutomation: '$studioAutomation' },
            leads: { $sum: 1 },
          },
        },
      ]),
      linkTrackingService.clickCountsBetween(workspaceId, start, end),
    ]);

    const messagesById = new Map(messageAgg.map((row) => [row._id.toString(), row]));
    const leadsByAutomation = new Map<string, number>();
    const leadsByStudioAutomation = new Map<string, number>();
    for (const row of leadAgg) {
      if (row._id.automation) {
        const id = row._id.automation.toString();
        leadsByAutomation.set(id, (leadsByAutomation.get(id) ?? 0) + row.leads);
      }
      if (row._id.studioAutomation) {
        const id = row._id.studioAutomation.toString();
        leadsByStudioAutomation.set(id, (leadsByStudioAutomation.get(id) ?? 0) + row.leads);
      }
    }

    const rows: AutomationFunnelRow[] = [
      ...automations.map((a) => {
        const id = a._id.toString();
        return {
          id,
          name: a.name,
          kind: 'classic' as const,
          platform: a.platform,
          triggerType: a.triggerType,
          status: a.status as string,
          triggered: messagesById.get(id)?.triggered ?? 0,
          dmSent: messagesById.get(id)?.dmSent ?? 0,
          clicked: clicks.byAutomation[id] ?? 0,
          leads: leadsByAutomation.get(id) ?? 0,
        };
      }),
      ...studioAutomations.map((a) => {
        const id = a._id.toString();
        return {
          id,
          name: a.name,
          kind: 'studio' as const,
          platform: a.platform,
          triggerType: a.triggerType,
          status: a.status as string,
          triggered: messagesById.get(id)?.triggered ?? 0,
          dmSent: messagesById.get(id)?.dmSent ?? 0,
          clicked: clicks.byStudioAutomation[id] ?? 0,
          leads: leadsByStudioAutomation.get(id) ?? 0,
        };
      }),
    ].sort(
      (a, b) => b.triggered - a.triggered || b.leads - a.leads || a.name.localeCompare(b.name)
    );

    const totals = rows.reduce(
      (acc, row) => ({
        triggered: acc.triggered + row.triggered,
        dmSent: acc.dmSent + row.dmSent,
        clicked: acc.clicked + row.clicked,
        leads: acc.leads + row.leads,
      }),
      { triggered: 0, dmSent: 0, clicked: 0, leads: 0 }
    );

    return { rangeDays, totals, rows };
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
    return toDateKeyUTC(new Date());
  }
}

export const analyticsService = new AnalyticsService();
