import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ScreeningService } from "../screening/screening.service.js";
import { EXCLUDED_CLASSES } from "../screening/universe.js";
import { runBacktest, type BacktestSnapshot, type BacktestReportData } from "./backtest.js";

@Injectable()
export class BacktestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly screening: ScreeningService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async run(opts: { includeFinalTest: boolean; minHistoryHours?: number }): Promise<{ id: string; report: BacktestReportData }> {
    const providerId = this.cfg.DATA_SOURCE;
    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    // Coins that never reached the market-cap floor can neither be screened nor enter the market
    // median, so the full-universe tail is not loaded (it would dominate memory). Plain floats:
    // the backtest's arithmetic is float-based and Decimal objects per value are too heavy here.
    const rows = await this.prisma.$queryRaw<
      Array<{ assetId: string; slotTime: Date; price: number | null; marketCap: number | null; fdv: number | null; volume: number | null; isStale: boolean; ch1: number | null; ch24: number | null; spread: number | null; depth: number | null; completeness: number | null; marketCapProvenance: string; qualityFlags: string[] }>
    >`
      SELECT s."assetId", s."slotTime", s.price::float8 AS price, s."marketCap"::float8 AS "marketCap", s."fullyDilutedValuation"::float8 AS fdv,
             s."volumeRolling24h"::float8 AS volume, s."isStale", s."providerChangePct1h"::float8 AS ch1, s."providerChangePct24h"::float8 AS ch24,
             s."bidAskSpreadPct"::float8 AS spread, s."depthPlus2PctUsd"::float8 AS depth, s.completeness::float8 AS completeness,
             s."marketCapProvenance", s."qualityFlags"
      FROM "MarketSnapshot" s
      WHERE s."providerId" = ${providerId} AND s."assetId" IN (
        SELECT DISTINCT u."assetId" FROM "MarketSnapshot" u JOIN "Asset" a ON a.id = u."assetId"
        WHERE u."providerId" = ${providerId} AND (a."isBenchmark" OR (a."assetClass" <> ALL(${[...EXCLUDED_CLASSES]}::text[]) AND u."marketCap" >= ${this.cfg.MIN_MARKET_CAP_USD}::numeric))
      )
      ORDER BY s."assetId", s."slotTime"`;
    const series = new Map<string, BacktestSnapshot[]>();
    for (const r of rows) {
      const list = series.get(r.assetId) ?? [];
      list.push({
        slotTime: r.slotTime,
        price: r.price,
        marketCap: r.marketCap,
        fullyDilutedValuation: r.fdv,
        volumeRolling24h: r.volume,
        isStale: r.isStale,
        providerChangePct1h: r.ch1,
        providerChangePct24h: r.ch24,
        bidAskSpreadPct: r.spread,
        depthPlus2PctUsd: r.depth,
        completeness: r.completeness ?? 0,
        marketCapProvenance: r.marketCapProvenance,
        qualityFlags: r.qualityFlags,
      });
      series.set(r.assetId, list);
    }
    const assets = await this.prisma.asset.findMany({
      where: { id: { in: [...series.keys()] } },
      select: { id: true, symbol: true, name: true, assetClass: true, isBenchmark: true },
    });
    const report = runBacktest(assets, series, this.screening.strategy, {
      shortlistSize: this.cfg.SHORTLIST_SIZE,
      snapshotWindow: this.cfg.SNAPSHOT_WINDOW,
      feeBps: this.cfg.PAPER_FEE_BPS,
      slippageBps: this.cfg.PAPER_SLIPPAGE_BPS,
      minHistoryHours: opts.minHistoryHours ?? 168,
      finalTestFraction: 0.2,
      includeFinalTest: opts.includeFinalTest,
      foldHours: 72,
    });
    const saved = await this.prisma.backtestReport.create({
      data: {
        strategyVersion: this.screening.strategy.version,
        status: report.status,
        periodStart: report.periodStart ? new Date(report.periodStart) : null,
        periodEnd: report.periodEnd ? new Date(report.periodEnd) : null,
        isLiveData: provider?.isLive ?? false,
        includesFinalTest: opts.includeFinalTest,
        report: report as never,
      },
    });
    return { id: saved.id, report };
  }
}
