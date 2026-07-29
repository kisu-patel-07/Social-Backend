import { IJobRun, JobRunModel } from '../models/jobRun.model';
import { BaseRepository } from './base.repository';

class JobRunRepository extends BaseRepository<IJobRun> {
  constructor() {
    super(JobRunModel);
  }

  /** Latest run per job key (for the Health page's cron cards). */
  async latestPerJob(): Promise<IJobRun[]> {
    return JobRunModel.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$job', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { job: 1 } },
    ]);
  }
}

export const jobRunRepository = new JobRunRepository();
