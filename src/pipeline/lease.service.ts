import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * Database-backed lease. Acquisition is a single atomic upsert evaluated with the database
 * clock, so two application instances can never both hold the same lease.
 */
@Injectable()
export class LeaseService {
  constructor(private readonly prisma: PrismaService) {}

  async acquire(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ holder: string }>>`
      INSERT INTO "JobLease" ("name", "holder", "acquiredAt", "heartbeatAt", "expiresAt")
      VALUES (${name}, ${holder}, now(), now(), now() + make_interval(secs => ${ttlMs / 1000}))
      ON CONFLICT ("name") DO UPDATE
        SET "holder" = EXCLUDED."holder",
            "acquiredAt" = CASE WHEN "JobLease"."holder" = EXCLUDED."holder" THEN "JobLease"."acquiredAt" ELSE EXCLUDED."acquiredAt" END,
            "heartbeatAt" = EXCLUDED."heartbeatAt",
            "expiresAt" = EXCLUDED."expiresAt"
        WHERE "JobLease"."expiresAt" < now() OR "JobLease"."holder" = EXCLUDED."holder"
      RETURNING "holder"`;
    return rows.length === 1 && rows[0]!.holder === holder;
  }

  async heartbeat(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "JobLease" SET "heartbeatAt" = now(), "expiresAt" = now() + make_interval(secs => ${ttlMs / 1000})
      WHERE "name" = ${name} AND "holder" = ${holder}`;
    return n === 1;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM "JobLease" WHERE "name" = ${name} AND "holder" = ${holder}`;
  }
}
