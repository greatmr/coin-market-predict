import { M001Enums1793923200001 } from './1793923200001-M001Enums.js';
import { M002Platform1793923200002 } from './1793923200002-M002Platform.js';
import { M003MarketData1793923200003 } from './1793923200003-M003MarketData.js';
import { M004DailyMetrics1793923200004 } from './1793923200004-M004DailyMetrics.js';
import { M005Venues1793923200005 } from './1793923200005-M005Venues.js';
import { M006ScanAndReviews1793923200006 } from './1793923200006-M006ScanAndReviews.js';
import { M007Users1793923200007 } from './1793923200007-M007Users.js';
import { M008ForwardTest1793923200008 } from './1793923200008-M008ForwardTest.js';
import { M009WeightedStarRanking1793923200009 } from './1793923200009-M009WeightedStarRanking.js';

/**
 * Every migration, in order, listed explicitly (no glob, so TypeScript tests and compiled ESM load
 * the same classes). A new migration (`npm run migration:create -- src/database/migrations/<Name>`)
 * is appended here. Applied migrations are never edited: change the schema with a new one.
 */
export const MIGRATIONS = [
  M001Enums1793923200001,
  M002Platform1793923200002,
  M003MarketData1793923200003,
  M004DailyMetrics1793923200004,
  M005Venues1793923200005,
  M006ScanAndReviews1793923200006,
  M007Users1793923200007,
  M008ForwardTest1793923200008,
  M009WeightedStarRanking1793923200009,
];
