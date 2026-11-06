import { z } from 'zod';

export const UuidSchema = z.string().uuid();

/** A CMC id in a path (`/api/assets/:cmcId/...`, `?cmcId=`). */
export const CmcIdSchema = z.coerce.number().int().positive().max(2_000_000_000);

/** An optional `batchId` (body or query): absent means "the latest batch". */
export const OptionalBatchSchema = z.object({ batchId: UuidSchema.optional() });
export type OptionalBatchDto = z.infer<typeof OptionalBatchSchema>;
