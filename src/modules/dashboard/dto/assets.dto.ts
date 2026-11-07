import { z } from 'zod';

/** `GET /api/assets`: CMC assets known to the crawler. */
export const AssetsQuerySchema = z.object({
  search: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AssetsQueryDto = z.infer<typeof AssetsQuerySchema>;

/** `GET /api/assets/:cmcId/snapshots`: hours of stored observations (default 72). */
export const SnapshotsQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(72),
});
export type SnapshotsQueryDto = z.infer<typeof SnapshotsQuerySchema>;
