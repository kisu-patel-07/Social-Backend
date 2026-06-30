import { Router } from 'express';
import { automationController } from '../controllers/automation.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  createAutomationSchema,
  listAutomationsSchema,
  toggleAutomationSchema,
  updateAutomationSchema,
} from '../validators/automation.validator';
import { idParamSchema } from '../validators/common.validator';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

router.post('/', validate(createAutomationSchema), automationController.create);
router.get('/', validate(listAutomationsSchema), automationController.list);
router.get('/:id', validate(z.object({ params: idParamSchema })), automationController.getById);
router.put('/:id', validate(updateAutomationSchema), automationController.update);
router.patch('/:id/status', validate(toggleAutomationSchema), automationController.setStatus);
router.delete('/:id', validate(z.object({ params: idParamSchema })), automationController.remove);

export default router;
