import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AppState } from './entities/app-state.entity.js';

/** Durable key/value state (JSON values). One row per key; writes are idempotent upserts. */
@Injectable()
export class AppStateService {
  constructor(@InjectRepository(AppState) private readonly repo: Repository<AppState>) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.repo.findOneBy({ key });
    return row ? (row.value as T) : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.repo.upsert({ key, value: value as never }, ['key']);
  }

  /** Store the value only when the key does not exist yet (first writer wins). */
  async setIfAbsent(key: string, value: unknown): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(AppState)
      .values({ key, value: value as never })
      .orIgnore()
      .execute();
  }
}
