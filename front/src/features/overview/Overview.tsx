// Overview: run pulse, the screen funnel, the queue strip, window / eligibility / star mixes,
// exclusion reasons, data quality and the Tier 1 rules.
import { Link, useNavigate } from 'react-router';

import { ChartBox, Donut, HBars } from '../../components/charts';
import { QUEUE, reasonText, statusText } from '../../lib/constants';
import { fmtInt, fmtTime, fmtUsd } from '../../lib/format';
import { pathOf } from '../../lib/routes';
import { useApp } from '../../state/app';
import type { AppConfig } from '../../types/api';

import Pulse from './Pulse';
import Quality, { qualityMeta } from './Quality';
import QueueStrip from './QueueStrip';
import { Funnel, type FunnelStage, StackRows } from './charts';
import type { ScanCountsDetail, Tally } from './types';

export default function Overview() {
  const { overview: ov, cfg } = useApp();
  const navigate = useNavigate();
  const b = ov ? ov.latestBatch : null,
    sc = ov ? ov.scan : null;
  const c: ScanCountsDetail = (sc?.counts as ScanCountsDetail | undefined) ?? {};
  const pass = (k: 'pass3d' | 'pass7d' | 'pass30d'): Tally => c.pass?.[k] ?? {};
  const st: Tally = c.stars ?? {};
  const reasons = Object.entries(c.reasons ?? {}).sort((x, y) => y[1] - x[1]);
  const noScan = <div className="empty">No scan yet.</div>;

  const stages: FunnelStage[] | null = sc
    ? [
        {
          label: 'Listed on CMC',
          value: c.assets || 0,
          sub: b ? `${fmtInt(b.collected)} of ${fmtInt(b.listedTotal)} collected` : '',
        },
        { label: 'Evaluated', value: c.evaluated || 0, sub: 'windows computed' },
        { label: 'Eligible', value: c.eligible || 0, sub: 'all hard filters pass' },
        { label: 'Review queue', value: c.queue || 0, sub: statusText(QUEUE, sc.queueStatus) },
      ]
    : null;

  return (
    <>
      <div className="hero">
        <Pulse />
        <div className="panel funnel-panel">
          <div className="panel-head">
            <h2>From every listed coin to the review queue</h2>
            <span className="hint">{sc ? `as of ${fmtTime(sc.asOf)}` : ''}</span>
          </div>
          <div>
            {!ov ? null : !stages ? (
              <div className="empty">No scan yet. The first run fills this in.</div>
            ) : (
              <ChartBox>{(W) => <Funnel W={W} stages={stages} />}</ChartBox>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Review queue</h2>
          <Link className="link" to={pathOf('queue')}>
            Open the full queue
          </Link>
        </div>
        <div className="queue-strip">{ov ? <QueueStrip sc={sc} /> : null}</div>
      </div>

      <div className="grid-3">
        <div className="panel">
          <div className="panel-head">
            <h2>Window results</h2>
            <span className="hint">evaluated coins</span>
          </div>
          <div>
            {!ov ? null : sc ? (
              <>
                <StackRows
                  rows={(['3d', '7d', '30d'] as const).map((w) => {
                    const p = pass(`pass${w}`);
                    return {
                      label: w,
                      segs: [
                        { value: p.YES || 0, tone: 'surge', label: 'YES' },
                        { value: p.NO || 0, tone: 'muted', label: 'NO' },
                        { value: p['N/A'] || 0, tone: 'na', label: 'N/A' },
                      ],
                    };
                  })}
                />
                <div className="legend-inline">
                  <span>
                    <i className="surge" />
                    YES
                  </span>
                  <span>
                    <i className="muted" />
                    NO
                  </span>
                  <span>
                    <i className="na" />
                    N/A
                  </span>
                </div>
              </>
            ) : (
              noScan
            )}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Eligibility</h2>
            <span className="hint">every coin in the batch</span>
          </div>
          <div>
            {!ov ? null : sc ? (
              <Donut
                totalLabel="coins"
                segs={[
                  {
                    label: 'Eligible',
                    value: c.eligible || 0,
                    tone: 'base',
                    onClick: () => navigate(pathOf('eligible')),
                  },
                  {
                    label: 'Needs review',
                    value: c.needsReview || 0,
                    tone: 'warn',
                    onClick: () => navigate(pathOf('needs_review')),
                  },
                  {
                    label: 'Excluded',
                    value: c.excluded || 0,
                    tone: 'muted',
                    onClick: () => navigate(pathOf('excluded')),
                  },
                ]}
              />
            ) : (
              noScan
            )}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Stars</h2>
            <span className="hint">windows met, evaluated coins</span>
          </div>
          <div>
            {!ov ? null : sc ? (
              <HBars
                items={['3', '2', '1', '0'].map((k) => ({
                  label: k === '0' ? 'No star' : `${k} ${k === '1' ? 'star' : 'stars'}`,
                  value: st[k] || 0,
                  tone: k === '0' ? 'muted' : `surge s${k}`,
                }))}
              />
            ) : (
              noScan
            )}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Why coins are left out</h2>
            <span className="hint">a coin can have several reasons</span>
          </div>
          <div>
            {ov ? (
              <HBars
                items={reasons.map(([k, v]) => ({ label: reasonText(k), value: v, tone: 'rose' }))}
                empty="No exclusions yet."
              />
            ) : null}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Data quality</h2>
            <span className="hint">{qualityMeta(ov)}</span>
          </div>
          <div>{ov ? <Quality ov={ov} sc={sc} c={c} /> : null}</div>
        </div>
      </div>

      <Rules cfg={cfg} />
    </>
  );
}

/** The ranking constants as /api/config sends them (strategy.ranking). */
interface Ranking {
  version: string;
  points?: Partial<Record<'3' | '7' | '30', number>>;
  strengthCap?: string | number;
}

function Rules({ cfg }: { cfg: AppConfig }) {
  const st = cfg.strategy,
    r = st.rules;
  const ranking = st.ranking as Ranking | undefined;
  const overrides = st.overrides;
  const items = [
    `Rank ${String(r.rankMin)}–${String(r.rankMax)} (current CMC rank, inclusive).`,
    `Circulating market cap at least ${fmtUsd(r.minMarketCapUsd as string | number | undefined)}.`,
    "Listed at least 60 × 24 h since CMC's date added (exactly 60 days qualifies).",
    'Not a stablecoin or tokenized stock or asset (CMC tags plus versioned overrides). Fan tokens stay eligible.',
    st.lbank?.requireManualVerification
      ? 'An LBank Spot pair (any quote currency), unambiguously mapped and verified tradable by you.'
      : `An LBank Spot pair (any quote currency) in the Markets list of CMC's LBank page, unambiguously mapped. The list refreshes every ${st.lbank ? st.lbank.refreshDays : 30} days or on demand.`,
    `VMC = volume ÷ market cap. Current = the rolling-24h quote, stale after ${st.maxQuoteAgeMinutes} min.`,
    'Means of completed UTC daily ratios over exactly the last 3, 7, 14 and 30 days. A missing or invalid day makes only its windows N/A.',
    `YES when current ≥ ${String(r.passMultiple)} × the mean (3d, 7d, 30d; 14d is context only). Stars = number of YES.`,
    ranking
      ? `Queue order (${ranking.version}): stars, then weighted points (3d ${ranking.points?.['3']} · 7d ${ranking.points?.['7']} · 30d ${ranking.points?.['30']} per YES; an N/A earns none and makes the score a lower bound), complete scores first, then weighted strength (multiples capped at ${ranking.strengthCap}), then the 3-day multiple, then CMC id. Weights are a product choice, not a probability.`
      : null,
  ].filter((x): x is string => !!x);
  const overridesText =
    'version' in overrides ? overrides.version : 'error' in overrides ? overrides.error : '—';
  return (
    <details className="panel rules">
      <summary>
        <h2>How Tier 1 decides</h2>
        <span className="hint">{`${st.rulesetVersion}, overrides ${overridesText || '—'}`}</span>
      </summary>
      <div>
        <ol className="rule-list">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      </div>
    </details>
  );
}
