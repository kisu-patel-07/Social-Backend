import { Router } from 'express';
import { z } from 'zod';
import { studioAutomationController } from '../controllers/studioAutomation.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import { idParamSchema } from '../validators/common.validator';
import {
  createStudioAutomationSchema,
  listStudioAutomationsSchema,
  toggleStudioAutomationSchema,
  updateStudioAutomationSchema,
} from '../validators/studioAutomation.validator';

const router = Router();

router.use(authenticate);

router.post('/', validate(createStudioAutomationSchema), studioAutomationController.create);
router.get('/', validate(listStudioAutomationsSchema), studioAutomationController.list);
router.get(
  '/:id',
  validate(z.object({ params: idParamSchema })),
  studioAutomationController.getById
);
router.put('/:id', validate(updateStudioAutomationSchema), studioAutomationController.update);
router.patch(
  '/:id/status',
  validate(toggleStudioAutomationSchema),
  studioAutomationController.setStatus
);
router.post(
  '/:id/duplicate',
  validate(z.object({ params: idParamSchema })),
  studioAutomationController.duplicate
);
router.delete(
  '/:id',
  validate(z.object({ params: idParamSchema })),
  studioAutomationController.remove
);

export default router;
