import { type ReviewInput, ReviewSchema } from '../../strategy/index.js';

/**
 * `POST /api/reviews`: one review revision (Tier 1 venue / event-day decision and Tier 2 chart
 * review with an optional trade plan). The schema is the strategy's own record definition (p.15,
 * p.24–27); completeness and consistency are judged by `validateReview`, never here.
 */
export const CreateReviewSchema = ReviewSchema;
export type CreateReviewDto = ReviewInput;
