import { ActivityLogModel, IActivityLog } from '../models/activityLog.model';
import { BaseRepository } from './base.repository';

class ActivityLogRepository extends BaseRepository<IActivityLog> {
  constructor() {
    super(ActivityLogModel);
  }
}

export const activityLogRepository = new ActivityLogRepository();
