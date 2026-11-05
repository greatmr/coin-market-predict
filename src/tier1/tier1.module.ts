import { Module } from "@nestjs/common";
import { SourcesModule } from "../sources/sources.module.js";
import { DailyService } from "./daily.service.js";
import { ExportService } from "./export.service.js";
import { ReviewService } from "./review.service.js";
import { ScanService } from "./scan.service.js";
import { VenuesService } from "./venues.service.js";

/** Two-Tier VMC strategy: Tier 1 inputs, scan, exports and the human review records. */
@Module({ imports: [SourcesModule], providers: [VenuesService, DailyService, ScanService, ExportService, ReviewService], exports: [VenuesService, DailyService, ScanService, ExportService, ReviewService] })
export class Tier1Module {}
