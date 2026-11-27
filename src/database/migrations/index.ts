import { M001Enums1793923200001 } from './1793923200001-M001Enums.js';
import { M002Platform1793923200002 } from './1793923200002-M002Platform.js';
import { M003MarketData1793923200003 } from './1793923200003-M003MarketData.js';
import { M004DailyMetrics1793923200004 } from './1793923200004-M004DailyMetrics.js';
import { M005Venues1793923200005 } from './1793923200005-M005Venues.js';
import { M006ScanAndReviews1793923200006 } from './1793923200006-M006ScanAndReviews.js';
import { M007Users1793923200007 } from './1793923200007-M007Users.js';
import { M008ForwardTest1793923200008 } from './1793923200008-M008ForwardTest.js';
import { M009WeightedStarRanking1793923200009 } from './1793923200009-M009WeightedStarRanking.js';
import { M010AgentAnalysis1793923200010 } from './1793923200010-M010AgentAnalysis.js';
import { M011ForwardCheckStatus1793923200011 } from './1793923200011-M011ForwardCheckStatus.js';
import { M012ExchangeListings1793923200012 } from './1793923200012-M012ExchangeListings.js';
import { M013ForwardDay0Hourly1793923200013 } from './1793923200013-M013ForwardDay0Hourly.js';
import { M014StorageScope1793923200014 } from './1793923200014-M014StorageScope.js';
import { M015LbankSpotObservation1793923200015 } from './1793923200015-M015LbankSpotObservation.js';
import { M016LbankObservationV21793923200016 } from './1793923200016-M016LbankObservationV2.js';
import { M017LbankFuturesSampled1793923200017 } from './1793923200017-M017LbankFuturesSampled.js';
import { M018LbankFuturesObservedQuote1793923200018 } from './1793923200018-M018LbankFuturesObservedQuote.js';
import { M019Chat1793923200019 } from './1793923200019-M019Chat.js';
import { M020ObservationFreshness1793923200020 } from './1793923200020-M020ObservationFreshness.js';

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
  M010AgentAnalysis1793923200010,
  M011ForwardCheckStatus1793923200011,
  M012ExchangeListings1793923200012,
  M013ForwardDay0Hourly1793923200013,
  M014StorageScope1793923200014,
  M015LbankSpotObservation1793923200015,
  M016LbankObservationV21793923200016,
  M017LbankFuturesSampled1793923200017,
  M018LbankFuturesObservedQuote1793923200018,
  M019Chat1793923200019,
  M020ObservationFreshness1793923200020,
];
