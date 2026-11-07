import { z } from 'zod';

import { CmcIdSchema } from './common.dto.js';

/** `GET /api/reviews?cmcId=`: every review revision of one asset. */
export const ReviewsQuerySchema = z.object({ cmcId: CmcIdSchema });
export type ReviewsQueryDto = z.infer<typeof ReviewsQuerySchema>;

/** `GET /api/mapping-tasks`: ambiguous LBank mappings by status. */
export const MappingTasksQuerySchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
});
export type MappingTasksQueryDto = z.infer<typeof MappingTasksQuerySchema>;
