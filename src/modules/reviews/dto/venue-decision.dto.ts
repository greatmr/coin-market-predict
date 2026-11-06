import { z } from 'zod';

import { LBANK, VENUE_DECISION_KINDS } from '../../strategy/index.js';

/** `POST /api/venue-decisions`: an append-only LBank tradability or mapping decision (p.10, A7, A9). */
export const VenueDecisionSchema = z
  .object({
    cmcId: z.number().int().positive(),
    batchId: z.string().uuid().optional(),
    exchange: z.literal(LBANK).default(LBANK),
    marketPair: z.string().trim().min(3).max(40).nullable().optional(),
    decision: z.enum(VENUE_DECISION_KINDS),
    reviewer: z.string().trim().min(1, 'reviewer is required').max(80),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export type VenueDecisionDto = z.infer<typeof VenueDecisionSchema>;
