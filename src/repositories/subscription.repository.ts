import { IPlan, PlanModel } from '../models/plan.model';
import { ISubscription, SubscriptionModel } from '../models/subscription.model';
import { IInvoice, InvoiceModel } from '../models/invoice.model';
import { IPayment, PaymentModel } from '../models/payment.model';
import { BaseRepository } from './base.repository';

class PlanRepository extends BaseRepository<IPlan> {
  constructor() {
    super(PlanModel);
  }

  listActive(): Promise<IPlan[]> {
    return this.find({ isActive: true }, undefined, { sort: { sortOrder: 1 } });
  }

  findByCode(code: string): Promise<IPlan | null> {
    return this.findOne({ code: code.toLowerCase() });
  }
}

class SubscriptionRepository extends BaseRepository<ISubscription> {
  constructor() {
    super(SubscriptionModel);
  }

  findByWorkspace(workspaceId: string): Promise<ISubscription | null> {
    return this.model.findOne({ workspace: workspaceId }).populate('plan').exec();
  }
}

class InvoiceRepository extends BaseRepository<IInvoice> {
  constructor() {
    super(InvoiceModel);
  }
}

class PaymentRepository extends BaseRepository<IPayment> {
  constructor() {
    super(PaymentModel);
  }
}

export const planRepository = new PlanRepository();
export const subscriptionRepository = new SubscriptionRepository();
export const invoiceRepository = new InvoiceRepository();
export const paymentRepository = new PaymentRepository();
