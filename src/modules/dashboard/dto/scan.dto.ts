import { z } from 'zod';

import { UuidSchema } from './common.dto.js';

/** `GET /api/scan`: one result sheet of a batch (PDF p.17). */
export const ScanQuerySchema = z.object({
  sheet: z.enum(['queue', 'eligible', 'needs_review', 'excluded', 'all']).default('queue'),
  batchId: UuidSchema.optional(),
  search: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ScanQueryDto = z.infer<typeof ScanQuerySchema>;
