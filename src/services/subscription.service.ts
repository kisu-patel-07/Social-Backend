import { IPlan } from '../models/plan.model';
import { ISubscription } from '../models/subscription.model';
import { IInvoice } from '../models/invoice.model';
import { invoiceRepository, planRepository, subscriptionRepository } from '../repositories';

/**
 * Read-only subscription/billing surface for the MVP. The data model is in
 * place so a payment gateway (Stripe/Razorpay) can be wired up later without
 * refactoring; no charging happens yet.
 */
class SubscriptionService {
  listPlans(): Promise<IPlan[]> {
    return planRepository.listActive();
  }

  getCurrent(workspaceId: string): Promise<ISubscription | null> {
    return subscriptionRepository.findByWorkspace(workspaceId);
  }

  listInvoices(workspaceId: string): Promise<IInvoice[]> {
    return invoiceRepository.find({ workspace: workspaceId }, undefined, {
      sort: { createdAt: -1 },
    });
  }
}

export const subscriptionService = new SubscriptionService();
