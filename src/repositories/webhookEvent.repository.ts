import { IWebhookEvent, WebhookEventModel } from '../models/webhookEvent.model';
import { BaseRepository } from './base.repository';

class WebhookEventRepository extends BaseRepository<IWebhookEvent> {
  constructor() {
    super(WebhookEventModel);
  }
}

export const webhookEventRepository = new WebhookEventRepository();
