import { Inject, Injectable, Logger } from '@nestjs/common';

import { redact } from '../common/security/redact.js';

import { APP_CONFIG } from './config.constants.js';
import type { AppConfig } from './env.validation.js';
import { LIVE_SETTING_KEYS, type SettingKey } from './settings.catalog.js';

export type ConfigChangeListener = (changed: ReadonlySet<SettingKey>) => void;

/**
 * The running configuration of this process. `APP_CONFIG` is one shared object that providers read
 * at call time, so a dashboard setting marked `live` is copied into it in place and takes effect
 * without a restart; listeners handle what was built from it (the cron jobs, the HTTP clients' rate
 * limits, the bot poller). `restart` settings are never copied: the process keeps the values it
 * started with, consistently everywhere.
 *
 * A pipeline run holds the configuration (`hold`): a change saved meanwhile waits until the run
 * ends, so the scan, export, report and forward test of one run always agree on every threshold.
 */
@Injectable()
export class LiveConfig {
  private readonly log = new Logger('Settings');
  private holds = 0;
  private pending: AppConfig | null = null;
  private readonly listeners = new Set<ConfigChangeListener>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** A pipeline run holds the configuration. */
  get held(): boolean {
    return this.holds > 0;
  }

  /** A change is waiting for the current run to finish. */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** Freeze the configuration until the returned function is called (idempotent). */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0 && this.pending) {
        const next = this.pending;
        this.pending = null;
        this.commit(next);
      }
    };
  }

  /** Take over the live settings of `next` now, or when the last hold is released. */
  apply(next: AppConfig): 'applied' | 'deferred' {
    if (this.holds > 0) {
      this.pending = next;
      return 'deferred';
    }
    this.pending = null;
    this.commit(next);
    return 'applied';
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private commit(next: AppConfig) {
    const changed = new Set<SettingKey>();
    const target = this.cfg as Record<SettingKey, unknown>;
    for (const key of LIVE_SETTING_KEYS) {
      if (Object.is(target[key], next[key])) continue;
      target[key] = next[key];
      changed.add(key);
    }
    if (!changed.size) return;
    this.log.log(`settings applied: ${[...changed].join(', ')}`);
    for (const listener of this.listeners) {
      try {
        listener(changed);
      } catch (err) {
        this.log.error(`applying ${[...changed].join(', ')} failed: ${redact(err)}`);
      }
    }
  }
}
