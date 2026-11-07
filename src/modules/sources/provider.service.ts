import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Provider } from './entities/provider.entity.js';
import type { ProviderInfo } from './source.types.js';

/** The `provider` registry: every market-data source that wrote a row is listed with its live flag. */
@Injectable()
export class ProviderService {
  constructor(@InjectRepository(Provider) private readonly repo: Repository<Provider>) {}

  /** Insert the provider or refresh its description (name, access method, live flag, URLs). */
  async upsert(info: ProviderInfo): Promise<void> {
    await this.repo.upsert(
      {
        id: info.id,
        name: info.name,
        accessMethod: info.accessMethod,
        isLive: info.isLive,
        baseUrl: info.baseUrl,
        termsUrl: info.termsUrl,
        attribution: info.attribution,
      },
      ['id'],
    );
  }

  /** Insert the provider when it is missing; an existing row is left as it is. */
  async ensureExists(info: ProviderInfo): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(Provider)
      .values({
        id: info.id,
        name: info.name,
        accessMethod: info.accessMethod,
        isLive: info.isLive,
        baseUrl: info.baseUrl,
        termsUrl: info.termsUrl,
        attribution: info.attribution,
      })
      .orIgnore()
      .execute();
  }

  find(id: string): Promise<Provider | null> {
    return this.repo.findOneBy({ id });
  }
}
