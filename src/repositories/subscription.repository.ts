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

  /** The active ₹0 plan (whatever its code), if one exists. */
  findFreeActivePlan(): Promise<IPlan | null> {
    return this.findOne({ isActive: true, priceAmount: 0 }, undefined, {
      sort: { sortOrder: 1 },
    });
  }

  /** Default plan for new signups: a ₹0 plan if present, else the cheapest active. */
  async findDefaultSignupPlan(): Promise<IPlan | null> {
    return (
      (await this.findFreeActivePlan()) ??
      this.findOne({ isActive: true }, undefined, { sort: { priceAmount: 1, sortOrder: 1 } })
    );
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
