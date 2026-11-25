import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

export interface StorageTable {
  name: string;
  /** Table + indexes + TOAST. */
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  /** Planner estimate (`pg_class.reltuples`), null before the table was first analyzed. */
  rowsEstimate: number | null;
}

export interface StorageReport {
  measuredAt: string;
  databaseBytes: number;
  tables: StorageTable[];
  retention: { detailDays: number; snapshotDays: number; candleDays: number };
}

/**
 * How much disk the database uses, per table (Data page). Reads PostgreSQL's catalog sizes only:
 * no `count(*)` over large tables, so it is cheap enough to load with the page.
 */
@Injectable()
export class StorageReportService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async report(): Promise<StorageReport> {
    const [db] = (await this.db.query(
      `SELECT pg_database_size(current_database())::bigint AS b`,
    )) as Array<{ b: string }>;
    const rows = (await this.db.query(
      `SELECT c.relname AS name,
              pg_total_relation_size(c.oid)::bigint AS total,
              pg_relation_size(c.oid)::bigint AS heap,
              pg_indexes_size(c.oid)::bigint AS idx,
              c.reltuples::bigint AS est
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname = current_schema()
        ORDER BY pg_total_relation_size(c.oid) DESC, c.relname`,
    )) as Array<{ name: string; total: string; heap: string; idx: string; est: string }>;
    return {
      measuredAt: new Date().toISOString(),
      databaseBytes: Number(db?.b ?? 0),
      tables: rows.map((r) => ({
        name: r.name,
        totalBytes: Number(r.total),
        tableBytes: Number(r.heap),
        indexBytes: Number(r.idx),
        rowsEstimate: Number(r.est) >= 0 ? Number(r.est) : null,
      })),
      retention: {
        detailDays: this.cfg.RETENTION_DETAIL_DAYS,
        snapshotDays: this.cfg.RETENTION_SNAPSHOT_DAYS,
        candleDays: this.cfg.LBANK_CANDLE_RETENTION_DAYS,
      },
    };
  }
}
