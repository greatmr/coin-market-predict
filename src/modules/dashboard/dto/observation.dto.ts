import { z } from 'zod';

import {
  COVERAGE_FILTERS,
  ELIGIBILITY_CLASSES,
  FLAG_FILTERS,
  OBSERVATION_STATUSES,
  OBS_SORT_KEYS,
} from '../../lbank-observation/observation.constants.js';

const isoDateTime = z
  .string()
  .trim()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a date or time');

/** Filters shared by the observation list, its summary and its export. */
export const ObservationFilterSchema = z.object({
  status: z.enum(OBSERVATION_STATUSES).optional(),
  eligibility: z.enum(ELIGIBILITY_CLASSES).optional(),
  stars: z.coerce.number().int().min(1).max(3).optional(),
  coverage: z.enum(COVERAGE_FILTERS).optional(),
  flags: z.enum(FLAG_FILTERS).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  search: z.string().trim().max(64).optional(),
});
export type ObservationFilterDto = z.infer<typeof ObservationFilterSchema>;

/** `GET /api/observations`. */
export const ObservationListQuerySchema = ObservationFilterSchema.extend({
  sort: z.enum(OBS_SORT_KEYS).default('detected'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ObservationListQueryDto = z.infer<typeof ObservationListQuerySchema>;

/** `GET /api/observations/export.csv`. */
export const ObservationExportQuerySchema = ObservationFilterSchema.extend({
  sort: z.enum(OBS_SORT_KEYS).default('detected'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ObservationExportQueryDto = z.infer<typeof ObservationExportQuerySchema>;
