import { type DynamicModule, Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "./config/config.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { ReadModelService } from "./read-model/read-model.service.js";

@Global()
@Module({})
export class CoreModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: APP_CONFIG, useValue: cfg }, PrismaService, ReadModelService],
      exports: [APP_CONFIG, PrismaService, ReadModelService],
    };
  }
}
