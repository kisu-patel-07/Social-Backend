import { IWorkspace, WorkspaceModel } from '../models/workspace.model';
import { BaseRepository } from './base.repository';

class WorkspaceRepository extends BaseRepository<IWorkspace> {
  constructor() {
    super(WorkspaceModel);
  }

  /** Atomically adjust a denormalized workspace stat counter. */
  async incrementStat(
    workspaceId: string,
    stat: keyof IWorkspace['stats'],
    delta: number
  ): Promise<void> {
    await this.model.updateOne({ _id: workspaceId }, { $inc: { [`stats.${stat}`]: delta } }).exec();
  }
}

export const workspaceRepository = new WorkspaceRepository();
