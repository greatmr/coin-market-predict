import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';
import { CreatedAtColumn, TextArrayColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { PipelineRun } from '../../pipeline/entities/pipeline-run.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import {
  MARKET_CAP_PROVENANCES,
  type MarketCapProvenance,
  SUPPLY_PROVENANCES,
  type SupplyProvenance,
} from '../validate.js';

import { Asset } from './asset.entity.js';

/**
 * One validated observation per provider asset, UTC hour slot and quote currency (the crawler's
 * stored records). First write wins: a replayed slot never duplicates or overwrites a row.
 */
@Entity({ name: 'market_snapshot' })
@Unique('ux_market_snapshot_observation', [
  'providerId',
  'providerAssetId',
  'slotTime',
  'quoteCurrency',
])
@Index('ix_market_snapshot_asset_slot', ['assetId', 'slotTime'])
@Index('ix_market_snapshot_slot', ['slotTime'])
export class MarketSnapshot extends HasBigintId {
  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @ManyToOne(() => Asset, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'asset_id' })
  asset?: Relation<Asset>;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'provider_asset_id', type: 'text' })
  providerAssetId!: string;

  /** Hourly bucket this observation belongs to (UTC, minute = 0) = the crawl batch slot. */
  @Column({ name: 'slot_time', type: 'timestamptz' })
  slotTime!: Date;

  /** Crawl time (our clock). */
  @Column({ name: 'collected_at', type: 'timestamptz' })
  collectedAt!: Date;

  /** Provider update time (CMC quote `lastUpdated`). NULL if not supplied. */
  @Column({ name: 'observed_at', type: 'timestamptz', nullable: true })
  observedAt!: Date | null;

  @Column({ name: 'source_url', type: 'text' })
  sourceUrl!: string;

  @Column({ name: 'quote_currency', type: 'text', default: 'USD' })
  quoteCurrency!: string;

  @DecimalColumn(38, 18, { nullable: true })
  price!: DValue | null;

  /** Circulating market cap. Never fully diluted valuation. */
  @DecimalColumn(38, 4, { name: 'market_cap', nullable: true })
  marketCap!: DValue | null;

  @Column({
    name: 'market_cap_provenance',
    type: 'enum',
    enum: [...MARKET_CAP_PROVENANCES],
    enumName: 'market_cap_provenance',
  })
  marketCapProvenance!: MarketCapProvenance;

  @DecimalColumn(38, 4, { name: 'fully_diluted_valuation', nullable: true })
  fullyDilutedValuation!: DValue | null;

  @DecimalColumn(38, 8, { name: 'circulating_supply', nullable: true })
  circulatingSupply!: DValue | null;

  @Column({
    name: 'supply_provenance',
    type: 'enum',
    enum: [...SUPPLY_PROVENANCES],
    enumName: 'supply_provenance',
  })
  supplyProvenance!: SupplyProvenance;

  /** Rolling 24h trading volume as reported by the provider at observedAt. */
  @DecimalColumn(38, 4, { name: 'volume_rolling_24h', nullable: true })
  volumeRolling24h!: DValue | null;

  /** Volume traded inside this hour (only from sources with hourly bars); never derived from 24h totals. */
  @DecimalColumn(38, 4, { name: 'volume_hourly', nullable: true })
  volumeHourly!: DValue | null;

  @Column({ name: 'volume_hourly_source', type: 'text', nullable: true })
  volumeHourlySource!: string | null;

  /** Provider-reported percentage changes (labelled provider fields, not computed by us). */
  @DecimalColumn(20, 8, { name: 'provider_change_pct_1h', nullable: true })
  providerChangePct1h!: DValue | null;

  @DecimalColumn(20, 8, { name: 'provider_change_pct_24h', nullable: true })
  providerChangePct24h!: DValue | null;

  @DecimalColumn(20, 8, { name: 'provider_change_pct_7d', nullable: true })
  providerChangePct7d!: DValue | null;

  /** Liquidity fields (NULL unless a source provides them). */
  @DecimalColumn(20, 8, { name: 'bid_ask_spread_pct', nullable: true })
  bidAskSpreadPct!: DValue | null;

  @DecimalColumn(38, 4, { name: 'depth_plus_2pct_usd', nullable: true })
  depthPlus2PctUsd!: DValue | null;

  @DecimalColumn(38, 4, { name: 'depth_minus_2pct_usd', nullable: true })
  depthMinus2PctUsd!: DValue | null;

  @Column({ name: 'liquidity_source', type: 'text', nullable: true })
  liquiditySource!: string | null;

  /** Provider rank at this observation (CMC `cmcRank`). NULL when the source gives none. */
  @Column({ type: 'integer', nullable: true })
  rank!: number | null;

  /** Provider first-listing date (CMC `dateAdded`). */
  @Column({ name: 'date_added', type: 'timestamptz', nullable: true })
  dateAdded!: Date | null;

  /** Raw provider tags at this observation (CMC `tags`). */
  @TextArrayColumn('tags')
  tags!: string[];

  /** Data-quality flags, e.g. ["stale_observation", "missing_market_cap"]. */
  @TextArrayColumn('quality_flags')
  qualityFlags!: string[];

  /** Fraction of core fields present (0..1). */
  @DecimalColumn(5, 4)
  completeness!: DValue;

  /** Seconds between observedAt and collectedAt; NULL when observedAt is unknown. */
  @Column({ name: 'freshness_seconds', type: 'integer', nullable: true })
  freshnessSeconds!: number | null;

  @Column({ name: 'is_stale', type: 'boolean', default: false })
  isStale!: boolean;

  /** field → reason for each NULL value. */
  @Column({ name: 'null_reasons', type: 'jsonb' })
  nullReasons!: Record<string, string>;

  @Column({ name: 'pipeline_run_id', type: 'uuid', nullable: true })
  pipelineRunId!: string | null;

  @ManyToOne(() => PipelineRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pipeline_run_id' })
  pipelineRun?: Relation<PipelineRun> | null;

  @CreatedAtColumn()
  createdAt!: Date;
}
