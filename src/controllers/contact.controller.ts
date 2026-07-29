import { Request, Response } from 'express';
import { NotificationType } from '../constants';
import { logger } from '../config/logger';
import { contactMessageRepository, notificationRepository, userRepository } from '../repositories';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

export const contactController = {
  /**
   * Public contact form. Persisted into the admin support inbox (the source of
   * truth for follow-up), plus a bell notification to every super admin so it
   * gets seen quickly.
   */
  submit: asyncHandler(async (req: Request, res: Response) => {
    const { name, email, subject, message } = req.body as {
      name: string;
      email: string;
      subject: string;
      message: string;
    };

    logger.info('Contact form submission', { name, email, subject });

    const saved = await contactMessageRepository.create({ name, email, subject, message });

    const admins = await userRepository.find({ isSuperAdmin: true }, '_id workspace');
    await Promise.all(
      admins.map((admin) =>
        notificationRepository.create({
          workspace: admin.workspace,
          user: admin._id,
          type: NotificationType.SYSTEM,
          title: `Support: ${subject}`,
          body: `${name} <${email}> — ${message.slice(0, 400)}`,
          link: '/admin/support',
          metadata: { contactForm: true, contactMessageId: String(saved._id) },
        })
      )
    );

    sendSuccess(res, null, "Message received — we'll reply to your email soon");
  }),
};
