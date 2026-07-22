import { Request, Response } from 'express';
import { DemoRequestStatus, DemoRequestTopic, NotificationType } from '../constants';
import { logger } from '../config/logger';
import { demoRequestRepository, notificationRepository, userRepository } from '../repositories';
import { emailService } from '../services/email/email.service';
import { NotFoundError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';

const TOPIC_LABELS: Record<DemoRequestTopic, string> = {
  [DemoRequestTopic.DEMO]: 'Product demo',
  [DemoRequestTopic.SETUP]: 'Account setup help',
  [DemoRequestTopic.BOTH]: 'Demo + setup help',
};

/** "Friday, 25 July 2026 at 3:30 pm IST" — the product schedules in IST. */
function formatIst(date: Date): string {
  const formatted = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(date);
  return `${formatted} IST`;
}

export const demoRequestController = {
  /**
   * Public "book a demo" form. Stores the enquiry and pings every super
   * admin's notification bell (same no-email-dependency pattern as the
   * contact form).
   */
  submit: asyncHandler(async (req: Request, res: Response) => {
    const { name, email, phone, topic, preferredDate, preferredSlot, message } = req.body as {
      name: string;
      email: string;
      phone?: string;
      topic: DemoRequestTopic;
      preferredDate?: string;
      preferredSlot?: string;
      message?: string;
    };

    const request = await demoRequestRepository.create({
      name,
      email,
      phone,
      topic,
      preferredDate,
      preferredSlot,
      message,
    });
    logger.info('Demo request received', { id: request._id.toString(), email, topic });

    const when = [preferredDate, preferredSlot].filter(Boolean).join(' · ');
    const admins = await userRepository.find({ isSuperAdmin: true }, '_id workspace');
    await Promise.all(
      admins.map((admin) =>
        notificationRepository.create({
          workspace: admin.workspace,
          user: admin._id,
          type: NotificationType.SYSTEM,
          title: `Demo request: ${TOPIC_LABELS[topic]}`,
          body: `${name} <${email}>${phone ? ` · ${phone}` : ''}${when ? ` · prefers ${when}` : ''}`,
          metadata: { demoRequest: true, demoRequestId: request._id.toString() },
        })
      )
    );

    // Confirmation to the requester (best-effort — a mail outage never fails the form).
    await emailService.sendDemoRequestReceived(email, name, TOPIC_LABELS[topic], when || undefined);

    sendSuccess(res, null, "Request received — we'll email you to confirm a time");
  }),

  /** GET /admin/demo-requests — paginated, filterable by status. */
  adminList: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const status = req.query.status as DemoRequestStatus | undefined;
    const result = await demoRequestRepository.paginate(
      status ? { status } : {},
      options,
      undefined,
      [{ path: 'handledBy', select: 'name email' }]
    );
    sendPaginated(res, result.items, result.meta);
  }),

  /** PATCH /admin/demo-requests/:id — schedule, complete, cancel, annotate. */
  adminUpdate: asyncHandler(async (req: Request, res: Response) => {
    const { status, scheduledAt, adminNote } = req.body as {
      status?: DemoRequestStatus;
      scheduledAt?: string;
      adminNote?: string;
    };
    const updated = await demoRequestRepository.updateById(req.params.id, {
      $set: {
        ...(status ? { status } : {}),
        ...(scheduledAt !== undefined
          ? { scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined }
          : {}),
        ...(adminNote !== undefined ? { adminNote } : {}),
        handledBy: req.user!.id,
      },
    });
    if (!updated) throw new NotFoundError('Demo request not found');

    // Scheduling (or re-scheduling) a call emails the requester the confirmed
    // time. Best-effort: brevoClient swallows non-critical send failures.
    if (updated.status === DemoRequestStatus.SCHEDULED && updated.scheduledAt && scheduledAt) {
      await emailService.sendDemoCallScheduled(
        updated.email,
        updated.name,
        formatIst(updated.scheduledAt),
        TOPIC_LABELS[updated.topic]
      );
    }

    sendSuccess(res, updated, 'Demo request updated');
  }),
};
