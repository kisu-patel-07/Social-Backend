import { Request, Response } from 'express';
import { NotificationType } from '../constants';
import { logger } from '../config/logger';
import { notificationRepository, userRepository } from '../repositories';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

export const contactController = {
  /**
   * Public contact form. Delivers the message to every super admin's
   * notification bell (no email dependency) and logs it for good measure.
   */
  submit: asyncHandler(async (req: Request, res: Response) => {
    const { name, email, subject, message } = req.body as {
      name: string;
      email: string;
      subject: string;
      message: string;
    };

    logger.info('Contact form submission', { name, email, subject });

    const admins = await userRepository.find({ isSuperAdmin: true }, '_id workspace');
    await Promise.all(
      admins.map((admin) =>
        notificationRepository.create({
          workspace: admin.workspace,
          user: admin._id,
          type: NotificationType.SYSTEM,
          title: `Contact form: ${subject}`,
          body: `${name} <${email}> — ${message.slice(0, 400)}`,
          metadata: { contactForm: true, name, email, subject },
        })
      )
    );

    sendSuccess(res, null, "Message received — we'll reply to your email soon");
  }),
};
