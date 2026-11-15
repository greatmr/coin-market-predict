import { z } from 'zod';

import {
  EVENT_RESULT_FILTERS,
  EVENT_SORT_KEYS,
  FORWARD_EVENT_STATUSES,
} from '../../forward-test/forward.constants.js';

/**
 * `GET /api/forward/events`: active (open / tracking / awaiting the final day), final, incomplete
 * or all; `status` narrows to one event status, `result` to a High-check result; sorted by `sort`.
 */
export const ForwardEventsQuerySchema = z.object({
  view: z.enum(['active', 'final', 'incomplete', 'all']).default('active'),
  status: z.enum(FORWARD_EVENT_STATUSES).optional(),
  result: z.enum(EVENT_RESULT_FILTERS).optional(),
  sort: z.enum(EVENT_SORT_KEYS).default('detected'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  stars: z.coerce.number().int().min(1).max(3).optional(),
  search: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ForwardEventsQueryDto = z.infer<typeof ForwardEventsQuerySchema>;

export const ForwardRejectionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ForwardRejectionsQueryDto = z.infer<typeof ForwardRejectionsQuerySchema>;

/** A sheet of the forward-test export (`events_final.csv`, …) or `workbook.xlsx`. */
export const ForwardExportFileSchema = z.string().regex(/^[a-z_]+\.(csv|xlsx)$/);
