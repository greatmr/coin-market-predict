import { z } from 'zod';

import { UuidSchema } from './common.dto.js';

/** `GET /api/scan`: the Review Queue of a batch (PDF p.17), the only per-coin sheet stored (D4). */
export const ScanQuerySchema = z.object({
  sheet: z.enum(['queue']).default('queue'),
  batchId: UuidSchema.optional(),
  search: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ScanQueryDto = z.infer<typeof ScanQuerySchema>;
