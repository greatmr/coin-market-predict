import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { dec, forStorage } from '../../common/utils/decimal.js';

import { AppStateService } from '../app-state/app-state.service.js';
import { CutoverService } from '../star-events/cutover.service.js';

import { ForwardEvent } from './entities/forward-event.entity.js';
import { ForwardLegacyClosure } from './entities/forward-legacy-closure.entity.js';
import type { ForwardEventStatus, PeakKind } from './forward.constants.js';
import {
  LEGACY_CLOSURES,
  LEGACY_CLOSURE_RULES_VERSION,
  type LegacyClosure,
  type LegacyClosureDecision,
  legacyClosure,
  retirementCheck,
} from './legacy-closure.js';

export interface LegacyRetirement {
  retiredAt: string;
  cutoverAt: string | null;
  events: number;
  closures: Record<LegacyClosure, number>;
  /** Reason codes (the part before ':') over the INCOMPLETE and DATA_UNAVAILABLE closures. */
  reasons: Record<string, number>;
  rulesVersion: string;
}

export interface LegacyStatus {
  providerId: string;
  state: 'active' | 'closing' | 'retired';
  cutoverAt: string | null;
  cutoverPassed: boolean;
  events: number;
  terminal: number;
  pending: number;
  pendingUntil: string | null;
  closures: Record<LegacyClosure, number>;
  reasons: Record<string, number>;
  why: string;
  retirement: LegacyRetirement | null;
}

const retirementKey = (providerId: string) => `forward.legacy.retirement.${providerId}`;
const zero = (): Record<LegacyClosure, number> =>
  Object.fromEntries(LEGACY_CLOSURES.map((c) => [c, 0])) as Record<LegacyClosure, number>;

/**
 * Winds the legacy forward test down after the cutover (docs/forward-test.md § 15): records each
 * pre-cutover event's explicit terminal outcome (`forward_legacy_closure`), and once the cutover
 * has passed and every legacy event is terminal, writes the retirement report (counts and reasons)
 * and marks the tracker retired — the daily High update then stops and the dashboard hides the page
 * from navigation. Legacy events, Highs and outcomes are never changed or deleted.
 */
@Injectable()
export class ForwardRetirementService {
  private readonly log = new Logger(ForwardRetirementService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly state: AppStateService,
    private readonly cutover: CutoverService,
  ) {}

  async retirement(providerId: string): Promise<LegacyRetirement | null> {
    return (await this.state.get<LegacyRetirement>(retirementKey(providerId))) ?? null;
  }

  async isRetired(providerId: string): Promise<boolean> {
    return (await this.retirement(providerId)) !== null;
  }

  /** The current state; with `write`, closures are recorded and the tracker retires when ready. */
  async evaluate(providerId: string, now: Date, opts: { write: boolean }): Promise<LegacyStatus> {
    const retired = await this.retirement(providerId);
    const cut = await this.cutover.status(providerId, now);
    const rows: Array<{
      id: string;
      status: ForwardEventStatus;
      evaluation_end: Date;
      last_check_status: string | null;
      last_check_note: string | null;
      result_version: number | null;
      peak_kind: PeakKind | null;
      peak_return_pct: string | null;
      missing_dates: string[] | null;
      invalid_dates: string[] | null;
      reasons: string[] | null;
    }> = await this.db.query(
      `SELECT e.id, e.status, e.evaluation_end, e.last_check_status, e.last_check_note,
              o.result_version, o.peak_kind, o.peak_return_pct::text AS peak_return_pct,
              o.missing_dates, o.invalid_dates, o.reasons
         FROM forward_event e
         LEFT JOIN LATERAL (
           SELECT * FROM forward_outcome fo WHERE fo.event_id = e.id ORDER BY fo.result_version DESC LIMIT 1
         ) o ON TRUE
        WHERE e.provider_id = $1`,
      [providerId],
    );
    const decisions: Array<{
      id: string;
      status: ForwardEventStatus;
      d: LegacyClosureDecision;
      r: (typeof rows)[number];
    }> = rows.map((r) => ({
      id: r.id,
      status: r.status,
      r,
      d: legacyClosure(
        {
          status: r.status,
          evaluationEnd: new Date(r.evaluation_end),
          lastCheckStatus: r.last_check_status,
          lastCheckNote: r.last_check_note,
        },
        r.result_version === null
          ? null
          : {
              resultVersion: r.result_version,
              peakKind: r.peak_kind ?? 'NONE',
              peakReturnPct: dec(r.peak_return_pct),
              missingDates: r.missing_dates ?? [],
              invalidDates: r.invalid_dates ?? [],
              reasons: r.reasons ?? [],
            },
        now,
      ),
    }));
    const check = retirementCheck({
      cutoverPassed: cut.passed,
      decisions: decisions.map((x) => x.d),
    });
    const closures = zero();
    const reasons: Record<string, number> = {};
    for (const { d } of decisions) {
      if (!d.terminal) continue;
      closures[d.closure]++;
      if (d.closure !== 'FINAL')
        for (const code of new Set(d.reasons.map((x) => x.split(':')[0]!)))
          reasons[code] = (reasons[code] ?? 0) + 1;
    }

    if (opts.write && !retired) {
      const terminal = decisions.filter((x) => x.d.terminal);
      if (terminal.length)
        await this.db
          .createQueryBuilder()
          .insert()
          .into(ForwardLegacyClosure)
          .values(
            terminal.map(({ id, status, d, r }) => ({
              eventId: id,
              closure: (d as Extract<LegacyClosureDecision, { terminal: true }>).closure,
              statusAtClosure: status,
              outcomeVersion: r.result_version ?? 0,
              peakKind: r.peak_kind,
              peakReturnPct: forStorage(dec(r.peak_return_pct)) as never,
              reasons: (d as Extract<LegacyClosureDecision, { terminal: true }>).reasons,
              closedAt: now,
              rulesVersion: LEGACY_CLOSURE_RULES_VERSION,
            })),
          )
          // A closure follows the event's latest outcome while the tracker runs (e.g. a late High
          // revision of a FINAL event); the first closing time is kept.
          .orUpdate(
            [
              'closure',
              'status_at_closure',
              'outcome_version',
              'peak_kind',
              'peak_return_pct',
              'reasons',
              'rules_version',
              'updated_at',
            ],
            ['event_id'],
          )
          .updateEntity(false)
          .execute();
      if (check.ready) {
        const report: LegacyRetirement = {
          retiredAt: now.toISOString(),
          cutoverAt: cut.cutoverAt,
          events: check.events,
          closures,
          reasons,
          rulesVersion: LEGACY_CLOSURE_RULES_VERSION,
        };
        await this.state.setIfAbsent(retirementKey(providerId), report);
        this.log.warn(
          `legacy forward test retired: ${report.events} events — FINAL ${closures.FINAL}, INCOMPLETE ${closures.INCOMPLETE}, DATA_UNAVAILABLE ${closures.DATA_UNAVAILABLE}; reasons ${JSON.stringify(reasons)}`,
        );
        return this.evaluate(providerId, now, { write: false });
      }
    }

    return {
      providerId,
      state: retired ? 'retired' : cut.passed ? 'closing' : 'active',
      cutoverAt: cut.cutoverAt,
      cutoverPassed: cut.passed,
      events: check.events,
      terminal: check.terminal,
      pending: check.pending,
      pendingUntil: check.pendingUntil?.toISOString() ?? null,
      closures,
      reasons,
      why: retired ? `retired ${retired.retiredAt}` : check.why,
      retirement: retired,
    };
  }

  /** Every stored closure row (administrative export). */
  closuresFor(providerId: string): Promise<ForwardLegacyClosure[]> {
    return this.db
      .getRepository(ForwardLegacyClosure)
      .createQueryBuilder('c')
      .innerJoin(ForwardEvent, 'e', 'e.id = c.event_id')
      .where('e.provider_id = :providerId', { providerId })
      .orderBy('c.closed_at', 'ASC')
      .getMany();
  }
}
