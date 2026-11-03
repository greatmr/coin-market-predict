import { BadRequestException, Controller, Get, Param } from "@nestjs/common";
import { plain } from "../read-model/plain.js";
import { VmcService } from "./vmc.service.js";

/** Read-only API for the Volume / Market Cap comparison (used by the dashboard). */
@Controller("api/vmc")
export class VmcController {
  constructor(private readonly vmc: VmcService) {}

  @Get("comparison")
  comparison() {
    return this.vmc.comparison();
  }

  @Get("capabilities")
  async capabilities() {
    return { capabilities: await this.vmc.capabilities() };
  }

  @Get("assets/:cmcId")
  async asset(@Param("cmcId") cmcId: string) {
    if (!/^[1-9]\d{0,9}$/.test(cmcId)) throw new BadRequestException("cmcId must be a CoinMarketCap numeric id");
    return plain(await this.vmc.assetDetail(Number(cmcId)));
  }
}
