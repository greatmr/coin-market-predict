import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import {
  APP_CONFIG,
  type AppConfig,
  CONFIG_INPUTS,
  type ConfigInputs,
  LiveConfig,
  type SavedSettings,
  type SettingKey,
  loadConfig,
  settingDef,
} from '../../config/index.js';

import {
  type SettingChange,
  SettingsError,
  type SettingsInput,
  type SettingsPlan,
  type SettingsView,
  describeSettings,
  planImport,
  planSettings,
} from './settings.plan.js';
import {
  type SettingHistoryRow,
  type SettingsActor,
  lockSettings,
  readHistory,
  readSavedSettings,
  readSavedValues,
  writeChanges,
} from './settings.store.js';

export interface SettingsSaveResult {
  changes: SettingChange[];
  /** applied = in force now; deferred = when the pipeline run in progress ends; unchanged = nothing to do. */
  outcome: 'applied' | 'deferred' | 'unchanged';
  /** Changed settings that are read only when the server starts. */
  restartRequired: SettingKey[];
  view: SettingsView;
}

/**
 * Dashboard settings of the running server: the owner's view, validated saves (environment
 * precedence and cross-field rules included) with their history, the import of environment values,
 * and applying saved settings to this process through `LiveConfig`.
 */
@Injectable()
export class SettingsService {
  private readonly log = new Logger('Settings');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CONFIG_INPUTS) private readonly inputs: ConfigInputs,
    private readonly live: LiveConfig,
  ) {}

  async view(): Promise<SettingsView> {
    return describeSettings({
      env: this.inputs.env,
      saved: await readSavedSettings(this.db.manager),
      running: this.cfg,
      waitingForRun: this.live.hasPending,
    });
  }

  save(input: SettingsInput, actor: SettingsActor): Promise<SettingsSaveResult> {
    return this.write((saved) => planSettings(this.inputs.env, saved, input), actor);
  }

  /** Copy the settings the environment sets into the dashboard (see `planImport`). */
  importEnvironment(actor: Omit<SettingsActor, 'source'>): Promise<SettingsSaveResult> {
    return this.write((saved) => planImport(this.inputs.env, saved), {
      ...actor,
      source: 'import_env',
    });
  }

  history(limit = 100): Promise<SettingHistoryRow[]> {
    return readHistory(this.db.manager, limit);
  }

  /**
   * Re-read the saved settings and apply them: picks up a change made with the CLI (or by another
   * instance). Called before each scheduled run; never throws.
   */
  async refresh(): Promise<void> {
    try {
      this.live.apply(this.configFor(await readSavedValues(this.db.manager)));
    } catch (err) {
      this.log.warn(
        `saved settings not applied: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async write(
    plan: (saved: SavedSettings) => SettingsPlan,
    actor: SettingsActor,
  ): Promise<SettingsSaveResult> {
    const result = await this.db.transaction(async (m) => {
      await lockSettings(m);
      const p = plan(await readSavedValues(m));
      if (p.issues.length) throw new SettingsError(p.issues);
      await writeChanges(m, p.changes, actor);
      return p;
    });
    const outcome = result.changes.length
      ? this.live.apply(this.configFor(result.saved))
      : 'unchanged';
    if (result.changes.length)
      this.log.log(
        `${actor.name} (${actor.source}) changed ${result.changes.map((c) => c.key).join(', ')}`,
      );
    return {
      changes: result.changes,
      outcome,
      restartRequired: result.changes
        .filter((c) => settingDef(c.key).apply === 'restart')
        .map((c) => c.key),
      view: await this.view(),
    };
  }

  /** This process's configuration with `saved`: same environment, same forced values. */
  private configFor(saved: SavedSettings): AppConfig {
    return loadConfig({ ...this.inputs.env, ...this.inputs.forced }, saved);
  }
}
