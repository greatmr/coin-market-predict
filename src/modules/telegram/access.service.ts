import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppStateService } from '../app-state/app-state.service.js';

const KEY = 'telegram.access';
const MAX_PENDING = 20;

export interface AccessEntry {
  label: string;
  at: string;
}

interface AccessState {
  approved: Record<string, AccessEntry>;
  pending: Record<string, AccessEntry>;
  denied: string[];
}

export type Role = 'owner' | 'member' | 'pending' | 'denied' | 'unknown';

/** Telegram chat ids are integers (users positive, groups/channels negative). */
export const isChatId = (s: string) => /^-?\d{3,20}$/.test(s);

/**
 * Who may use the bot. The owner is TELEGRAM_CHAT_ID (env, always allowed, the only one who can
 * run the pipeline or manage access). Everyone else needs the owner's approval; approved people
 * get the hourly report and the read-only commands. Stored in `app_state` (key "telegram.access").
 */
@Injectable()
export class TelegramAccessService {
  constructor(
    private readonly state: AppStateService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get owner(): string {
    return String(this.cfg.TELEGRAM_CHAT_ID ?? '');
  }

  private async load(): Promise<AccessState> {
    const v = (await this.state.get<Partial<AccessState>>(KEY)) ?? {};
    return { approved: v.approved ?? {}, pending: v.pending ?? {}, denied: v.denied ?? [] };
  }

  private async save(s: AccessState) {
    await this.state.set(KEY, s);
  }

  async list() {
    return this.load();
  }

  /** Approved chat ids (not including the owner). */
  async members(): Promise<string[]> {
    return Object.keys((await this.load()).approved);
  }

  async role(chatId: string): Promise<Role> {
    if (chatId === this.owner) return 'owner';
    const s = await this.load();
    if (s.approved[chatId]) return 'member';
    if (s.pending[chatId]) return 'pending';
    if (s.denied.includes(chatId)) return 'denied';
    return 'unknown';
  }

  /** Record an access request. Returns false when the pending queue is full (request ignored). */
  async request(chatId: string, label: string): Promise<boolean> {
    const s = await this.load();
    if (Object.keys(s.pending).length >= MAX_PENDING) return false;
    s.pending[chatId] = { label: label.slice(0, 40), at: new Date().toISOString() };
    await this.save(s);
    return true;
  }

  async approve(chatId: string): Promise<AccessEntry> {
    const s = await this.load();
    // `at` becomes the approval time: reports created before it were never owed to this person.
    const entry = {
      label: s.pending[chatId]?.label ?? 'added by owner',
      at: new Date().toISOString(),
    };
    delete s.pending[chatId];
    s.denied = s.denied.filter((d) => d !== chatId);
    s.approved[chatId] = entry;
    await this.save(s);
    return entry;
  }

  async deny(chatId: string): Promise<void> {
    const s = await this.load();
    delete s.pending[chatId];
    if (!s.denied.includes(chatId)) s.denied.push(chatId);
    await this.save(s);
  }

  /** Revoke an approved member (they can ask again, unlike a denied chat). */
  async remove(chatId: string): Promise<boolean> {
    const s = await this.load();
    const had = !!s.approved[chatId];
    delete s.approved[chatId];
    await this.save(s);
    return had;
  }
}
