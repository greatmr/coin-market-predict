import { Inject, Injectable } from "@nestjs/common";
import { addHours } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { median } from "../features/compute.js";
import { PrismaService, toNum } from "../prisma/prisma.service.js";
import type { PaperScenario } from "../screening/scenario.js";
import type { ResearchTarget } from "../screening/strategy.js";
import { evaluateTarget } from "./outcome.js";
import { simulatePosition, type Observation } from "./simulate.js";

const EXCLUDED = ["stablecoin", "wrapped", "bridged", "staked"];

@Injectable()
export class EvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Paper positions are opened only for "candidate" signals. No real orders exist anywhere. */
  async openPositions(signalIds: string[]) {
    const signals = await this.prisma.signal.findMany({ where: { id: { in: signalIds }, status: "candidate", paperPosition: null } });
    for (const s of signals) {
      const sc = s.scenario as unknown as PaperScenario;
      await this.prisma.paperPosition.create({
        data: {
          signalId: s.id,
          assetId: s.assetId,
          strategyVersion: s.strategyVersion,
          status: "pending_entry",
          referencePrice: sc.referencePrice,
          entryTriggerPrice: sc.entryTriggerPrice,
          stopPrice: sc.stopPrice,
          targetPrice: sc.targetPrice,
          trailingStopPct: sc.trailPct,
          maxHoldHours: sc.maxHoldHours,
          signalExpiresAt: new Date(sc.signalExpiresAt),
          feeBps: sc.feeBps,
          slippageBps: sc.slippageBps,
          notes: [sc.executionAssumption],
        },
      });
    }
    return signals.length;
  }

  async observations(providerId: string, assetId: string, from: Date, to: Date): Promise<Observation[]> {
    const rows = await this.prisma.marketSnapshot.findMany({
      where: { providerId, assetId, slotTime: { gt: from, lte: to } },
      orderBy: { slotTime: "asc" },
      select: { slotTime: true, price: true, isStale: true },
    });
    return rows.map((r) => ({ slotTime: r.slotTime, price: toNum(r.price), isStale: r.isStale }));
  }

  /** Re-simulate every unfinished paper position from stored observations up to `asOf`. */
  async updatePositions(providerId: string, asOf: Date) {
    const open = await this.prisma.paperPosition.findMany({ where: { status: { in: ["pending_entry", "open"] } }, include: { signal: true } });
    let changed = 0;
    for (const p of open) {
      const sc = p.signal.scenario as unknown as PaperScenario;
      const obs = await this.observations(providerId, p.assetId, p.signal.slotTime, addHours(p.signal.slotTime, sc.maxHoldHours + 12));
      const r = simulatePosition(
        {
          signalSlot: p.signal.slotTime,
          entryTriggerPrice: sc.entryTriggerPrice,
          stopPct: this.stopPct(sc),
          targetPct: sc.targetPrice / sc.entryTriggerPrice - 1,
          trailActivatePct: sc.trailActivatePct,
          trailPct: sc.trailPct,
          maxHoldHours: sc.maxHoldHours,
          signalExpiresAt: new Date(sc.signalExpiresAt),
          feeBps: p.feeBps,
          slippageBps: p.slippageBps,
        },
        obs,
        asOf,
      );
      await this.prisma.paperPosition.update({
        where: { id: p.id },
        data: {
          status: r.status,
          entryAt: r.entryAt,
          entryPrice: r.entryPrice,
          highWaterPrice: r.highWaterPrice,
          exitAt: r.exitAt,
          exitPrice: r.exitPrice,
          exitReason: r.exitReason,
          grossReturn: r.grossReturn,
          netReturn: r.netReturn,
          maxAdverseExcursion: r.maxAdverseExcursion,
          ambiguousOrdering: r.ambiguousOrdering,
          notes: [...new Set([...p.notes, ...r.notes])],
        },
      });
      changed++;
    }
    return changed;
  }

  private stopPct(sc: PaperScenario) {
    return 1 - sc.stopPrice / sc.entryTriggerPrice;
  }

  /** Median return of non-excluded assets between two slots (point-in-time universe at `from`). */
  async marketMedianReturn(providerId: string, from: Date, to: Date): Promise<number | null> {
    const rows = await this.prisma.marketSnapshot.findMany({
      where: { providerId, slotTime: { in: [from, to] }, isStale: false, asset: { assetClass: { notIn: EXCLUDED } } },
      select: { assetId: true, slotTime: true, price: true },
    });
    const start = new Map<string, number>();
    const end = new Map<string, number>();
    for (const r of rows) {
      const p = toNum(r.price);
      if (p === null) continue;
      (r.slotTime.getTime() === from.getTime() ? start : end).set(r.assetId, p);
    }
    const rets: number[] = [];
    for (const [id, p0] of start) {
      const p1 = end.get(id);
      if (p1 !== undefined) rets.push(p1 / p0 - 1);
    }
    return rets.length >= 5 ? median(rets) : null;
  }

  /** Label signals against their research target once observations exist. */
  async updateOutcomes(providerId: string, target: ResearchTarget, asOf: Date) {
    const signals = await this.prisma.signal.findMany({
      where: {
        status: { in: ["candidate", "watch"] },
        slotTime: { gte: addHours(asOf, -24 * 14) },
        OR: [{ outcomes: { none: { targetVersion: target.version } } }, { outcomes: { some: { targetVersion: target.version, status: "pending" } } }],
      },
      select: { id: true, assetId: true, slotTime: true, scenario: true },
    });
    for (const s of signals) {
      const ref = (s.scenario as unknown as PaperScenario).referencePrice;
      const end = addHours(s.slotTime, target.horizonHours);
      const obs = await this.observations(providerId, s.assetId, s.slotTime, end);
      const bench = asOf >= end ? await this.marketMedianReturn(providerId, s.slotTime, end) : null;
      const o = evaluateTarget(target, s.slotTime, ref, obs, bench, asOf);
      const data = {
        status: o.status,
        horizonHours: target.horizonHours,
        evaluatedAt: asOf,
        maxReturn: o.maxReturn,
        minReturn: o.minReturn,
        finalReturn: o.finalReturn,
        benchmarkReturn: bench,
        observations: o.observations,
        notes: ["observed at hourly snapshots only", `benchmark: ${target.benchmark}`],
      };
      await this.prisma.signalOutcome.upsert({
        where: { signalId_targetVersion: { signalId: s.id, targetVersion: target.version } },
        create: { signalId: s.id, targetVersion: target.version, ...data },
        update: data,
      });
    }
    return signals.length;
  }
}
