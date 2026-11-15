// Tier 1 decisions (venue, event day) and Tier 2 chart review + manual Spot trade plan
// (PDF p.15, p.24–27). Every save is a new, append-only revision; the server validates the plan.
import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  useState,
} from 'react';

import { apiPost, errorMessage } from '../../lib/api';
import { toast } from '../../lib/feedback';
import { shortId, utc } from '../../lib/format';
import { useApp } from '../../state/app';

import type { ChartFields } from './panels/ChartPanel';
import type { AssetTrace, ReviewSaved, ReviewValidation } from './types';

/** The chart fields ChartPanel can fill (names match the review API). */
export const CHART_FIELDS: readonly (keyof ChartFields)[] = [
  'chartExchange',
  'chartSymbol',
  'chartQuote',
  'chartUrl',
  'chartTimezone',
  'chartProxyReason',
];

type Result = { error: string } | { msg: string; validation: ReviewValidation } | null;

function Select({
  name,
  options,
  value,
  allowEmpty = true,
}: {
  name: string;
  options: readonly string[];
  value: string | null | undefined;
  allowEmpty?: boolean;
}) {
  return (
    <select id={`rv-${name}`} name={name} defaultValue={value ?? ''}>
      {allowEmpty ? <option value="">—</option> : null}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | null;
  children: ReactNode;
}) => (
  <label className="field">
    <span>{label}</span>
    {children}
    {hint ? <small className="hint">{hint}</small> : null}
  </label>
);
const Input = ({
  name,
  value,
  ...attrs
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue'> & {
  name: string;
  value: string | null | undefined;
}) => <input id={`rv-${name}`} name={name} defaultValue={value ?? ''} {...attrs} />;

function SaveResult({ result }: { result: Result }) {
  if (!result) return null;
  if ('error' in result) return <div className="error">{`Not saved: ${result.error}`}</div>;
  const val = result.validation;
  return (
    <div
      className={val.planStatus === 'INCOMPLETE' || val.errors.length ? 'banner inline' : 'note-ok'}
    >
      {`${result.msg}.`}
      {val.errors.length ? (
        <ul className="notes">
          {val.errors.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : null}
      {val.warnings.length ? (
        <ul className="notes">
          {val.warnings.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** `formRef` receives the <form> element (venue decisions read the venue note, ChartPanel fills chart fields). */
export default function ReviewForm({
  t,
  reload,
  formRef,
}: {
  t: AssetTrace;
  reload: (batchId: string) => Promise<unknown>;
  formRef: Ref<HTMLFormElement>;
}) {
  const { cfg, me, can } = useApp();
  const r = t.record,
    R = cfg.review;
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const last = t.reviews.find((x) => x.batchId === r.batchId) || null;
  const pairs = t.lbank.pairs.map((p) => p.marketPair);
  const plan = last?.plan ?? null;
  const tp = (i: number, k: 'price' | 'allocationPct') => plan?.targets?.[i]?.[k] ?? '';
  const canWrite = can('review:write');
  // The signed-in user is the reviewer of record (the server sets it from the session, too).
  const reviewer = me.username;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = (name: string): string | undefined => {
      const x = fd.get(name);
      return typeof x === 'string' && x.trim() ? x.trim() : undefined;
    };
    const targets = [0, 1, 2]
      .map((i) => ({ price: v(`tp${i}-price`), allocationPct: v(`tp${i}-alloc`) }))
      .filter((x) => x.price || x.allocationPct);
    const entryTime = v('entryTime');
    const planBody = {
      entryPrice: v('entryPrice'),
      entryTime: entryTime ? new Date(`${entryTime}:00Z`).toISOString() : undefined,
      stopPrice: v('stopPrice'),
      targets: targets.length ? targets : undefined,
      notes: v('notes'),
    };
    const hasPlan = Object.values(planBody).some((x) => x !== undefined);
    const body: Record<string, unknown> = {
      cmcId: r.cmcId,
      batchId: r.batchId,
      reviewer,
      venueDecision: v('venueDecision'),
      venueNote: v('venueNote'),
      eventDay: v('eventDay'),
      lbankPair: v('lbankPair'),
      ...Object.fromEntries(CHART_FIELDS.map((k) => [k, v(k)])),
      rangeLow: v('rangeLow'),
      chartHistory: v('chartHistory'),
      priorPumpResponse: v('priorPumpResponse'),
      candleState: v('candleState'),
      marketRegime: v('marketRegime'),
      finalDecision: v('finalDecision'),
      rationale: v('rationale'),
      plan: hasPlan ? planBody : undefined,
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    setBusy(true);
    try {
      const res = await apiPost<ReviewSaved>('reviews', body);
      const val = res.validation;
      const msg = `Saved revision ${res.review.revision}${val.planStatus ? `, plan ${val.planStatus}` : ''}`;
      setResult({ msg, validation: val });
      toast(`${msg}.`, val.errors.length ? 'warning' : 'ok');
      await reload(r.batchId);
    } catch (err) {
      const message = errorMessage(err);
      setResult({ error: message });
      toast(`Review not saved: ${message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel review-panel">
      <div className="panel-head">
        <h3>Your review</h3>
        <span className="hint">
          {last
            ? `revision ${last.revision} saved for this batch`
            : `for batch ${shortId(r.batchId)}`}
        </span>
      </div>
      {/* Remounts with the saved values when a new revision arrives (a venue decision keeps your edits). */}
      <form
        key={`${r.batchId}:${last ? last.id : 'new'}`}
        ref={formRef}
        className="review-form"
        autoComplete="off"
        onSubmit={submit}
      >
        <fieldset>
          <legend>Tier 1: venue and event day</legend>
          <Field label="Reviewer">
            <input id="rv-reviewer" value={reviewer} readOnly title="Recorded from your sign-in" />
          </Field>
          <Field label="Venue decision">
            <Select
              name="venueDecision"
              options={R.venueDecisions}
              value={last?.venueDecision || 'PENDING'}
              allowEmpty={false}
            />
          </Field>
          <Field label="Venue note">
            <Input
              name="venueNote"
              value={last?.venueNote}
              maxLength={1000}
              placeholder="e.g. only Upbit active"
            />
          </Field>
          <Field
            label="Event day"
            hint="first or second day of unusual volume, judged from the VMC chart"
          >
            <Select
              name="eventDay"
              options={R.eventDays}
              value={last?.eventDay || 'UNKNOWN'}
              allowEmpty={false}
            />
          </Field>
        </fieldset>
        <fieldset>
          <legend>Tier 2: 1D chart review</legend>
          <Field label="Verified LBank pair">
            <Select name="lbankPair" options={pairs} value={last?.lbankPair} />
          </Field>
          <Field label="Chart exchange">
            <Input
              name="chartExchange"
              value={last?.chartExchange}
              placeholder="LBank (preferred) or proxy"
            />
          </Field>
          <Field label="Chart symbol">
            <Input name="chartSymbol" value={last?.chartSymbol} placeholder={`${r.symbol}USDT`} />
          </Field>
          <Field label="Quote currency">
            <Input name="chartQuote" value={last?.chartQuote} />
          </Field>
          <Field label="Chart URL">
            <Input name="chartUrl" type="url" value={last?.chartUrl} />
          </Field>
          <Field label="Candle-close timezone" hint="CMC daily rows close at 00:00 UTC">
            <Input name="chartTimezone" value={last?.chartTimezone} placeholder="e.g. UTC" />
          </Field>
          <Field label="Proxy reason (non-LBank chart)">
            <Input name="chartProxyReason" value={last?.chartProxyReason} />
          </Field>
          <Field label="Range low vs. top">
            <Select name="rangeLow" options={R.judgments} value={last?.rangeLow} />
          </Field>
          <Field label="Chart history (real upward waves)">
            <Select name="chartHistory" options={R.judgments} value={last?.chartHistory} />
          </Field>
          <Field label="Prior pump response">
            <Select
              name="priorPumpResponse"
              options={R.judgments}
              value={last?.priorPumpResponse}
            />
          </Field>
          <Field label="Candle state">
            <Select name="candleState" options={R.candleStates} value={last?.candleState} />
          </Field>
          <Field label="BTC/ETH regime">
            <Select name="marketRegime" options={R.marketRegimes} value={last?.marketRegime} />
          </Field>
          <Field label="Final decision">
            <Select
              name="finalDecision"
              options={R.finalDecisions}
              value={last?.finalDecision || 'REVIEW'}
              allowEmpty={false}
            />
          </Field>
          <Field label="Rationale">
            <textarea
              id="rv-rationale"
              name="rationale"
              rows={3}
              maxLength={4000}
              defaultValue={last?.rationale || ''}
            />
          </Field>
        </fieldset>
        <fieldset>
          <legend>Manual LBank Spot trade plan (PLAN_READY only)</legend>
          <p className="small muted wide">
            You choose every price. Validation only checks completeness and stop &lt; entry &lt; TP1
            &lt; TP2 &lt; TP3; the stop % and the 7 × 24 h time exit are derived. No sizing, order
            type or execution exists here.
          </p>
          <Field label="Entry price (USD)">
            <Input name="entryPrice" inputMode="decimal" value={plan?.entryPrice} />
          </Field>
          <Field label="Entry time (UTC)">
            <Input
              name="entryTime"
              type="datetime-local"
              value={plan?.entryTime ? plan.entryTime.slice(0, 16) : ''}
            />
          </Field>
          <Field
            label="Stop price (USD)"
            hint={plan?.stopPct ? `stop ${Number(plan.stopPct).toFixed(2)}% below entry` : null}
          >
            <Input name="stopPrice" inputMode="decimal" value={plan?.stopPrice} />
          </Field>
          {[0, 1, 2].map((i) => [
            <Field key={`p${i}`} label={`TP${i + 1} price`}>
              <Input name={`tp${i}-price`} inputMode="decimal" value={tp(i, 'price')} />
            </Field>,
            <Field key={`a${i}`} label={`TP${i + 1} allocation %`}>
              <Input name={`tp${i}-alloc`} inputMode="decimal" value={tp(i, 'allocationPct')} />
            </Field>,
          ])}
          <Field label="Plan notes">
            <textarea
              id="rv-notes"
              name="notes"
              rows={2}
              maxLength={2000}
              defaultValue={plan?.notes || ''}
            />
          </Field>
          {plan?.deadline ? (
            <div className="small wide">{`Time exit: ${utc(plan.deadline)}`}</div>
          ) : null}
        </fieldset>
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={!canWrite || busy}>
            {last ? 'Save new revision' : 'Save review'}
          </button>
          {canWrite ? null : (
            <span className="muted small">Your role can read reviews but not record them.</span>
          )}
        </div>
        <div id="rv-result" className="small" aria-live="polite">
          <SaveResult result={result} />
        </div>
      </form>
    </section>
  );
}
