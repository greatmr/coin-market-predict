import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { VmcService } from "./vmc.service.js";

/**
 * Schedules (UTC): hourly quote collection (VMC_HOURLY_CRON) and the weekly daily-history
 * refresh + baseline recalculation (VMC_BASELINE_CRON). On startup it syncs asset metadata and
 * performs the one-time baseline build and 72-hour backfill when they have not been done.
 */
@Injectable()
export class VmcScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("VmcScheduler");
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly vmc: VmcService,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cfg.VMC_SCHEDULER_ENABLED) return;
    if (this.vmc.assetIds.length === 0) {
      this.log.warn("VMC scheduler enabled but VMC_ASSET_IDS is empty: nothing is monitored");
      return;
    }
    const add = (name: string, cron: string, fn: () => Promise<unknown>) => {
      const job = CronJob.from({ cronTime: cron, timeZone: "UTC", start: true, onTick: () => void fn().catch((e) => this.log.error(`${name}: ${redact(e)}`)) });
      this.registry.addCronJob(name, job);
    };
    add("vmc-hourly", this.cfg.VMC_HOURLY_CRON, async () => {
      const r = await this.vmc.hourly();
      await this.vmc.writeComparison();
      this.log.log(`hourly: ${r.status} (credits ${r.creditsUsed})`);
    });
    add("vmc-weekly", this.cfg.VMC_BASELINE_CRON, async () => {
      const r = await this.vmc.weekly();
      this.log.log(`weekly: ${r.map((x) => `${x.job}=${x.status}`).join(", ")}`);
    });
    this.timer = setTimeout(() => void this.startup().catch((e) => this.log.error(`startup: ${redact(e)}`)), 3_000);
  }

  onApplicationShutdown() {
    if (this.timer) clearTimeout(this.timer);
    for (const n of ["vmc-hourly", "vmc-weekly"]) if (this.registry.doesExist("cron", n)) void this.registry.getCronJob(n).stop();
  }

  private async startup() {
    await this.vmc.syncAssets();
    const haveBaseline = await this.prisma.vmcBaseline.count({ where: { cmcId: { in: this.vmc.assetIds } } });
    if (!haveBaseline) await this.vmc.weekly();
    await this.vmc.hourlyBackfill();
    this.log.log("startup: assets synced, baseline and backfill checked");
  }
}
