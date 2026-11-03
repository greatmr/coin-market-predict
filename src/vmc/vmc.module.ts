import { Module } from "@nestjs/common";
import { LeaseService } from "../pipeline/lease.service.js";
import { VmcController } from "./vmc.controller.js";
import { VmcScheduler } from "./vmc.scheduler.js";
import { VmcService } from "./vmc.service.js";
import { CmcWebModule } from "../sources/coinmarketcap-web/web.module.js";

/** Volume / Market Cap baseline collection (CoinMarketCap brief). Independent of the signal pipeline. */
@Module({ imports: [CmcWebModule], providers: [VmcService, VmcScheduler, LeaseService], controllers: [VmcController], exports: [VmcService] })
export class VmcModule {}
