import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SourcesModule } from '../sources/sources.module.js';

import { AssetContract } from './entities/asset-contract.entity.js';
import { AssetIdentity } from './entities/asset-identity.entity.js';
import { Asset } from './entities/asset.entity.js';
import { CmcAssetChange } from './entities/cmc-asset-change.entity.js';
import { CmcAsset } from './entities/cmc-asset.entity.js';
import { CrawlBatch } from './entities/crawl-batch.entity.js';
import { DiscoveryRun } from './entities/discovery-run.entity.js';
import { MarketSnapshot } from './entities/market-snapshot.entity.js';
import { IngestionService } from './ingestion.service.js';

/** Market data in: discovery, hourly crawl batches, asset identity, snapshots, CMC asset metadata. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Asset,
      AssetIdentity,
      AssetContract,
      DiscoveryRun,
      CrawlBatch,
      MarketSnapshot,
      CmcAsset,
      CmcAssetChange,
    ]),
    SourcesModule,
  ],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
