import { DemoRequestModel, IDemoRequest } from '../models/demoRequest.model';
import { BaseRepository } from './base.repository';

class DemoRequestRepository extends BaseRepository<IDemoRequest> {
  constructor() {
    super(DemoRequestModel);
  }
}

export const demoRequestRepository = new DemoRequestRepository();
