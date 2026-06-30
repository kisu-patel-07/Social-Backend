import { Types } from 'mongoose';
import { ActivityAction } from '../constants';
import { activityLogRepository } from '../repositories';
import { logger } from '../config/logger';

interface LogActivityParams {
  workspace: string;
  user?: string;
  action: ActivityAction;
  description: string;
  entityType?: string;
  entityId?: string | Types.ObjectId;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/** Records an audit-trail entry. Failures are swallowed (never block the request). */
class ActivityService {
  async log(params: LogActivityParams): Promise<void> {
    try {
      await activityLogRepository.create({
        workspace: new Types.ObjectId(params.workspace),
        user: params.user ? new Types.ObjectId(params.user) : undefined,
        action: params.action,
        description: params.description,
        entityType: params.entityType,
        entityId: params.entityId ? new Types.ObjectId(params.entityId) : undefined,
        metadata: params.metadata,
        ip: params.ip,
      });
    } catch (error) {
      logger.warn('Failed to write activity log', { error: (error as Error).message });
    }
  }
}

export const activityService = new ActivityService();
