import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService, toNum } from "../prisma/prisma.service.js";
import { ScreeningService } from "../screening/screening.service.js";
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
    const rows = await this.prisma.marketSnapshot.findMany({
      where: { providerId },
      orderBy: [{ assetId: "asc" }, { slotTime: "asc" }],
      select: {
        assetId: true,
        slotTime: true,
        price: true,
        marketCap: true,
        fullyDilutedValuation: true,
        volumeRolling24h: true,
        isStale: true,
        providerChangePct1h: true,
        providerChangePct24h: true,
        bidAskSpreadPct: true,
        depthPlus2PctUsd: true,
        completeness: true,
        marketCapProvenance: true,
        qualityFlags: true,
      },
    });
    const series = new Map<string, BacktestSnapshot[]>();
    for (const r of rows) {
      const list = series.get(r.assetId) ?? [];
      list.push({
        slotTime: r.slotTime,
        price: toNum(r.price),
        marketCap: toNum(r.marketCap),
        fullyDilutedValuation: toNum(r.fullyDilutedValuation),
        volumeRolling24h: toNum(r.volumeRolling24h),
        isStale: r.isStale,
        providerChangePct1h: toNum(r.providerChangePct1h),
        providerChangePct24h: toNum(r.providerChangePct24h),
        bidAskSpreadPct: toNum(r.bidAskSpreadPct),
        depthPlus2PctUsd: toNum(r.depthPlus2PctUsd),
        completeness: toNum(r.completeness) ?? 0,
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
