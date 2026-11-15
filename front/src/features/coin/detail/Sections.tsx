// The coin page's summary and the read-only sections of its tabs (LBank pairs, calculation
// details, history). Source text (names, notes, metadata values) is rendered as React text.
import { Chip, type Column, Kv, PassCell, Stars, Table } from '../../../components/ui';
import { apiUrl } from '../../../lib/config';
import { CURRENT, ELIG, LBANK, type StatusMap, reasonText } from '../../../lib/constants';
import { fmtPrice, fmtTime, fmtUsd, fmtVmc, shortId, utc } from '../../../lib/format';
import { useApp } from '../../../state/app';

import type {
  AssetTrace,
  DailyRow,
  LbankPair,
  MetadataChange,
  ReviewRow,
  TraceWindow,
  VenueDecisionRow,
} from '../types';

const lowerSpaced = (s: string) => String(s).replace(/_/g, ' ').toLowerCase();
const dotOf = (map: StatusMap, k: string) => map[k]?.[0] || '';
const textOf = (map: StatusMap, k: string) => map[k]?.[1] || k;

export function CoinHero({ t }: { t: AssetTrace }) {
  const { live } = useApp();
  const r = t.record,
    elig = t.eligibility;
  return (
    <section className="coin-hero">
      <div className="coin-price">
        <b>{fmtPrice(r.priceUsd)}</b>
        <span>{`cap ${fmtUsd(r.capUsd)}, 24h volume ${fmtUsd(r.volume24hUsd)}`}</span>
      </div>
      <div className="coin-vmc">
        <span>current VMC</span>
        <b>{fmtVmc(r.currentVmc)}</b>
        <Stars n={r.stars} />
      </div>
      <div className="chips">
        {r.inQueue ? (
          <Chip strong dot="accent">
            {`Review queue #${r.queueOrder}`}
          </Chip>
        ) : null}
        <Chip dot={dotOf(ELIG, elig.status)}>{textOf(ELIG, elig.status)}</Chip>
        <Chip dot={dotOf(LBANK, r.lbankStatus)}>{textOf(LBANK, r.lbankStatus)}</Chip>
        <Chip dot={dotOf(CURRENT, r.currentStatus)}>{textOf(CURRENT, r.currentStatus)}</Chip>
        {live && r.slug ? (
          <a
            className="chip link-chip"
            href={`https://coinmarketcap.com/currencies/${encodeURIComponent(r.slug)}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            CoinMarketCap
          </a>
        ) : null}
      </div>
      {elig.reasons.length ? (
        <div className="chips">
          <span className="muted small">Left out because:</span>
          {elig.reasons.map((x) => (
            <Chip key={x} tone="rose">
              {reasonText(x)}
            </Chip>
          ))}
        </div>
      ) : null}
      {r.flags.length || r.venueFlags.length ? (
        <div className="chips">
          <span className="muted small">Flags:</span>
          {[...r.flags, ...r.venueFlags].map((x, i) => (
            <Chip key={i} tone="warn">
              {lowerSpaced(x)}
            </Chip>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const mappingDot = (m: string) =>
  m === 'OK' || m === 'CONFIRMED' ? 'good' : m === 'AMBIGUOUS' ? 'serious' : 'critical';
const tradingDot = (s: string) =>
  s === 'TRADING' ? 'good' : s === 'UNVERIFIED' ? 'warning' : 'critical';

export type Decide = (decision: string, marketPair: string | null) => void;

/** LBank Spot pairs for the coin, with the reviewer's mapping and tradability decisions. */
export function LbankPanel({ t, decide }: { t: AssetTrace; decide: Decide }) {
  const { can, cfg } = useApp();
  const lb = t.lbank;
  const canWrite = can('review:write');
  const manual = cfg.strategy.lbank?.requireManualVerification;
  const cols: Column<LbankPair>[] = [
    {
      label: 'Pair',
      render: (p) =>
        p.marketUrl ? (
          <a href={p.marketUrl} target="_blank" rel="noopener noreferrer">
            <b>{p.marketPair}</b>
          </a>
        ) : (
          <b>{p.marketPair}</b>
        ),
    },
    {
      label: 'Mapping',
      render: (p) => <Chip dot={mappingDot(p.mapping)}>{p.mapping.toLowerCase()}</Chip>,
    },
    {
      label: 'Trading',
      render: (p) => (
        <Chip
          dot={tradingDot(p.trading)}
        >{`${p.trading.toLowerCase()}${p.tradingSource ? ` (${p.tradingSource})` : ''}`}</Chip>
      ),
    },
    { label: 'Vol 24h', num: true, render: (p) => fmtUsd(p.volumeUsd) },
    {
      label: '',
      render: (p) =>
        canWrite ? (
          <div className="row-actions">
            {p.mapping === 'AMBIGUOUS' ? (
              <>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => decide('MAPPING_CONFIRMED', p.marketPair)}
                >
                  Mapping correct
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => decide('MAPPING_REJECTED', p.marketPair)}
                >
                  Wrong asset
                </button>
              </>
            ) : null}
            {p.trading !== 'TRADING' ? (
              <button
                type="button"
                className="btn small primary"
                onClick={() => decide('VERIFIED_TRADABLE', p.marketPair)}
              >
                Verified tradable
              </button>
            ) : null}
            <button
              type="button"
              className="btn small danger"
              onClick={() => decide('NOT_TRADABLE', p.marketPair)}
            >
              Not tradable
            </button>
          </div>
        ) : null,
    },
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>LBank Spot pairs</h3>
        <span className="hint">
          {lb.crawl
            ? `list ${lb.crawl.status.toLowerCase()}, ${fmtTime(lb.crawl.finishedAt)}`
            : 'no list'}
        </span>
      </div>
      <div className="table-wrap">
        <Table
          cols={cols}
          rows={lb.pairs}
          rowKey={(p) => p.marketPair}
          empty={`No LBank Spot pair maps to this CMC id (${lb.status}${lb.reason ? `: ${lb.reason}` : ''}).`}
        />
      </div>
      {lb.status === 'UNKNOWN' && lb.reason === 'PAIR_DISAPPEARED' && canWrite ? (
        <button type="button" className="btn danger" onClick={() => decide('NOT_TRADABLE', null)}>
          Confirm: no tradable LBank pair
        </button>
      ) : null}
      {lb.tasks.length ? (
        <div className="chips">
          <span className="muted small">Mapping tasks:</span>
          {lb.tasks.map((x, i) => (
            <Chip key={i} dot={x.status === 'OPEN' ? 'serious' : 'good'}>
              {`${x.marketPair} ${x.kind} ${x.status}`}
            </Chip>
          ))}
        </div>
      ) : null}
      {lb.decisions.length ? (
        <p className="muted small">
          {`${lb.decisions.length} LBank decision${lb.decisions.length === 1 ? '' : 's'} recorded; see the History tab.`}
        </p>
      ) : null}
      <p className="muted small">
        {manual
          ? "Pairs come from the Markets section of CMC's LBank page, mapped by CMC coin id. That list has no trading status, so a pair counts as tradable only after you verify it on LBank."
          : "Pairs come from the Markets section of CMC's LBank page, mapped by CMC coin id. A listed, unambiguous pair counts as tradable; mark it not tradable if LBank shows otherwise."}
      </p>
    </section>
  );
}

/* ---------- Calculation details ---------- */

export function CurrentObservation({ t }: { t: AssetTrace }) {
  const r = t.record,
    b = t.batch,
    elig = t.eligibility;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Current observation</h3>
        <span className="hint">rolling 24h, not volume traded this hour</span>
      </div>
      <p className="formula">{t.current.formula}</p>
      <Kv
        pairs={[
          ['Provider update time', utc(r.observedAt)],
          ['Crawl time', utc(r.crawledAt)],
          ['Scan time', utc(r.computedAt)],
          [
            'Listed',
            `${utc(r.dateAdded)} (${r.ageDays === null ? '?' : Number(r.ageDays).toFixed(2)} days)`,
          ],
          ['Class', `${elig.assetClass} [${elig.classSource}]`],
          ['Batch', `${shortId(b.id)}, slot ${fmtTime(b.slotTime)}`],
        ]}
      />
    </section>
  );
}

export function WindowsPanel({ t }: { t: AssetTrace }) {
  const cols: Column<TraceWindow>[] = [
    { label: 'Window', render: (w) => `${w.days}d` },
    {
      label: 'Dates',
      render: (w) => (w.dates.length ? `${w.dates[w.dates.length - 1]} → ${w.dates[0]}` : '—'),
    },
    {
      label: 'Mean VMC',
      num: true,
      render: (w) =>
        w.mean === null ? (
          <span className="muted" title={reasonText(w.reason)}>
            {`N/A, ${reasonText(w.reason)}`}
          </span>
        ) : (
          fmtVmc(w.mean, true)
        ),
    },
    {
      label: 'Result',
      render: (w) =>
        w.pass ? (
          <PassCell status={w.pass.status} multiple={w.pass.multiple} reason={w.pass.reason} />
        ) : (
          <span className="muted">context only</span>
        ),
    },
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Windows</h3>
        <span className="hint">mean of daily ratios, never Σvolume ÷ Σcap</span>
      </div>
      <div className="table-wrap">
        <Table cols={cols} rows={t.windows} rowKey={(w) => w.days} />
      </div>
      <ul className="notes mono formulas">
        {t.windows.flatMap((w) => [
          <li key={`${w.days}f`}>{w.formula}</li>,
          w.comparison ? <li key={`${w.days}c`}>{w.comparison}</li> : null,
        ])}
      </ul>
    </section>
  );
}

const usd = (x: string | null) => (x === null ? '—' : Number(x).toLocaleString('en-US'));

export function DailyRowsPanel({ t }: { t: AssetTrace }) {
  const cols: Column<DailyRow>[] = [
    { label: 'Day', render: (d) => `T−${d.daysAgo}` },
    { label: 'Date', render: (d) => d.dateUtc },
    { label: 'Volume (USD)', num: true, render: (d) => usd(d.volumeUsd) },
    { label: 'Market cap (USD)', num: true, render: (d) => usd(d.marketCapUsd) },
    {
      label: 'VMC',
      num: true,
      render: (d) =>
        d.vmc === null ? (
          <span className="error">
            {d.valid === false ? `invalid: ${d.invalidReasons.join(', ')}` : 'missing'}
          </span>
        ) : (
          fmtVmc(d.vmc)
        ),
    },
    { label: 'Close', num: true, render: (d) => fmtPrice(d.closeUsd) },
    {
      label: 'Rev.',
      num: true,
      render: (d) =>
        d.revision === null ? '—' : `${d.revision}${d.revisedSinceScan ? ' (revised since)' : ''}`,
    },
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Completed UTC daily rows used</h3>
        <span className="hint">{`as of ${t.daily.asOfDate}; the open day is never used`}</span>
      </div>
      <div className="table-wrap">
        <Table
          cols={cols}
          rows={t.daily.used}
          rowKey={(d) => d.dateUtc}
          empty="Not evaluated: no daily rows are requested for excluded coins."
        />
      </div>
    </section>
  );
}

/* ---------- History ---------- */

export function ReviewHistory({ t }: { t: AssetTrace }) {
  const cols: Column<ReviewRow>[] = [
    { label: 'When', render: (x) => fmtTime(x.reviewedAt) },
    { label: 'Batch', render: (x) => `${shortId(x.batchId)} r${x.revision}` },
    { label: 'Reviewer', render: (x) => x.reviewer },
    { label: 'Venue, day', render: (x) => `${x.venueDecision}, ${x.eventDay}` },
    {
      label: 'Decision',
      render: (x) => (
        <Chip tone="violet">{`${x.finalDecision}${x.planStatus ? ` (${x.planStatus})` : ''}`}</Chip>
      ),
    },
    {
      label: 'Validation',
      render: (x) => (
        <span className="small">
          {[...(x.validation?.errors || []), ...(x.validation?.warnings || [])].join('; ')}
        </span>
      ),
    },
    {
      label: '',
      render: (x) => (
        <a
          href={apiUrl(`reviews/${encodeURIComponent(x.id)}/export`)}
          target="_blank"
          rel="noopener"
        >
          Export
        </a>
      ),
    },
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Review history</h3>
        <span className="hint">every save is a new revision</span>
      </div>
      <div className="table-wrap">
        <Table cols={cols} rows={t.reviews} rowKey={(x) => x.id} empty="No review yet." />
      </div>
    </section>
  );
}

export function LbankDecisions({ t }: { t: AssetTrace }) {
  const cols: Column<VenueDecisionRow>[] = [
    { label: 'When', render: (d) => fmtTime(d.decidedAt) },
    {
      label: 'Decision',
      render: (d) => (
        <Chip
          tone={
            d.decision === 'NOT_TRADABLE' || d.decision === 'MAPPING_REJECTED' ? 'rose' : 'violet'
          }
        >
          {lowerSpaced(d.decision)}
        </Chip>
      ),
    },
    { label: 'Pair', render: (d) => d.marketPair || '(coin)' },
    { label: 'Reviewer', render: (d) => d.reviewer },
    { label: 'Note', render: (d) => <span className="small">{d.note || ''}</span> },
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>LBank decisions</h3>
        <span className="hint">mapping and tradability decisions, newest first</span>
      </div>
      <div className="table-wrap">
        <Table cols={cols} rows={t.lbank.decisions} empty="No LBank decision recorded." />
      </div>
    </section>
  );
}

export function MetadataChanges({ changes }: { changes: MetadataChange[] }) {
  const cols: Column<MetadataChange>[] = [
    { label: 'Seen', render: (x) => fmtTime(x.observedAt) },
    { label: 'Field', render: (x) => x.field },
    { label: 'Before', render: (x) => <span className="small muted">{x.oldValue ?? '—'}</span> },
    { label: 'After', render: (x) => <span className="small">{x.newValue ?? '—'}</span> },
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>CMC metadata changes</h3>
        <span className="hint">name, symbol, tags or platform changes seen between crawls</span>
      </div>
      <div className="table-wrap">
        <Table
          cols={cols}
          rows={changes}
          empty="No metadata change since the coin was first seen."
        />
      </div>
    </section>
  );
}
