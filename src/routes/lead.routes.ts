import { Router } from 'express';
import { leadController } from '../controllers/lead.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import { requireEntitlement } from '../services/subscription.service';
import {
  bulkDeleteLeadsSchema,
  bulkUpdateLeadsSchema,
  exportLeadsSchema,
  listLeadsSchema,
  updateLeadSchema,
} from '../validators/lead.validator';
import { idParamSchema } from '../validators/common.validator';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

router.get('/', validate(listLeadsSchema), leadController.list);
router.get('/stats', leadController.stats);
router.get(
  '/export',
  requireEntitlement('csvExport'),
  validate(exportLeadsSchema),
  leadController.exportCsv
);
router.patch('/bulk', validate(bulkUpdateLeadsSchema), leadController.bulkUpdate);
router.post('/bulk-delete', validate(bulkDeleteLeadsSchema), leadController.bulkDelete);
router.get('/:id', validate(z.object({ params: idParamSchema })), leadController.getById);
router.put('/:id', validate(updateLeadSchema), leadController.update);
router.delete('/:id', validate(z.object({ params: idParamSchema })), leadController.remove);

export default router;
