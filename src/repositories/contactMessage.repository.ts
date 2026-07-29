import { ContactMessageModel, IContactMessage } from '../models/contactMessage.model';
import { BaseRepository } from './base.repository';

class ContactMessageRepository extends BaseRepository<IContactMessage> {
  constructor() {
    super(ContactMessageModel);
  }
}

export const contactMessageRepository = new ContactMessageRepository();
