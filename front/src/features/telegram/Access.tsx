// Telegram: who receives the hourly report (members, pending requests, rejected chats) and the
// reports that did not arrive in the last 6 hours.
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { type Column, LoadError, SkeletonTable, StatusLabel, Table } from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import type { StatusMap } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtTime } from '../../lib/format';
import { useApp } from '../../state/app';

import type {
  AccessChangeResult,
  AccessRow,
  DeliveryResult,
  MissedDelivery,
  TelegramAccess,
  TelegramMissing,
} from './types';

const MISSED_STATE: StatusMap = {
  pending: ['accent', 'Queued'],
  retrying: ['warning', 'Retrying'],
  gave_up: ['critical', 'Gave up'],
  not_queued: ['', 'Not sent'],
};

type AccessAction = 'approve' | 'reject' | 'remove';
interface MemberRow extends AccessRow {
  owner?: boolean;
}

const Who = ({ r }: { r: { label: string; chatId: string } }) => (
  <span>
    <strong>{r.label}</strong> <span className="muted small">{`id ${r.chatId}`}</span>
  </span>
);
const Act = ({
  label,
  cls,
  onClick,
  enabled,
}: {
  label: string;
  cls?: string;
  onClick: () => void;
  enabled: boolean;
}) => (
  <button
    type="button"
    className={`btn small${cls ? ` ${cls}` : ''}`}
    disabled={!enabled}
    onClick={onClick}
  >
    {label}
  </button>
);
const WHEN: Column<AccessRow> = { label: 'Since', render: (r) => (r.at ? fmtTime(r.at) : '') };

export default function Access() {
  const { setNavCount } = useApp();
  const [data, setData] = useState<{ a: TelegramAccess; missed: TelegramMissing } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [addId, setAddId] = useState('');
  // One change at a time, as the old page did (a module-level flag there).
  const busy = useRef(false);

  const load = useCallback(async () => {
    const [a, missed] = await Promise.all([
      api<TelegramAccess>('telegram/access'),
      api<TelegramMissing>('telegram/missing'),
    ]);
    setNavCount('access', a.pending.length + missed.rows.length);
    setData({ a, missed });
    setError(null);
  }, [setNavCount]);

  useEffect(() => {
    load().catch((e: unknown) => {
      console.error(e);
      setError(e);
    });
  }, [load]);

  const changeAccess = async (
    action: AccessAction,
    chatId: string,
    doneMsg: string,
  ): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      const r = await apiPost<AccessChangeResult>(`telegram/access/${action}`, { chatId });
      await load();
      if (action === 'approve' && r && r.notified === false)
        toast(
          `${doneMsg} Telegram would not deliver the welcome message: they must open the bot and press Start.`,
          'warning',
        );
      else toast(doneMsg);
      return true;
    } catch (e) {
      toast(`Could not change access: ${errorMessage(e)}`, 'error');
      return false;
    } finally {
      busy.current = false;
    }
  };

  const deliveryAction = async (path: string, body: Record<string, unknown>, okMsg: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await apiPost<DeliveryResult>(path, body);
      const d = r.delivery;
      const outcome = d
        ? `${d.sent} sent${d.failed ? `, ${d.failed} failed` : ''}${d.deferred ? `, ${d.deferred} will retry` : ''}`
        : r.reason || ((r.queued ?? r.requeued) ? 'sending in the background' : 'nothing to send');
      toast(`${okMsg}: ${outcome}.`, d && d.failed ? 'warning' : 'ok');
    } catch (e) {
      toast(`Could not send: ${errorMessage(e)}`, 'error');
    } finally {
      busy.current = false;
    }
    await load().catch(() => undefined);
  };

  const a = data?.a;
  const missed = data?.missed;
  const canManage = !!a?.canManage;

  let note: ['error' | 'ok', string] | null = null;
  if (a) {
    if (!a.canManage) note = ['error', 'Your role can see but not change Telegram access.'];
    else if (a.mode !== 'live' || !a.commandsEnabled)
      note = [
        'ok',
        `Telegram is ${a.mode}${a.commandsEnabled ? '' : ' and bot commands are off'}: new people can only ask for access when the app runs with TELEGRAM_MODE=live.`,
      ];
  }

  const missedCols: Column<MissedDelivery>[] = [
    { label: 'Report hour', render: (r) => fmtTime(r.slotTime) },
    { label: 'Person', render: (r) => <Who r={r} /> },
    {
      label: 'State',
      render: (r) => (
        <StatusLabel
          dot={MISSED_STATE[r.state]?.[0]}
          text={MISSED_STATE[r.state]?.[1] ?? r.state}
        />
      ),
    },
    { label: 'Parts', render: (r) => (r.partCount ? `${r.partsSent}/${r.partCount}` : '—') },
    {
      label: 'Why',
      render: (r) =>
        r.state === 'not_queued'
          ? 'no copy was queued for this person'
          : r.lastError || 'waiting to be sent',
    },
    {
      label: '',
      render: (r) => (
        <Act
          enabled={canManage}
          label={r.state === 'not_queued' ? 'Send' : 'Retry'}
          onClick={() =>
            void (r.state === 'not_queued'
              ? deliveryAction(
                  'telegram/send',
                  { runId: r.runId, chatIds: [r.chatId] },
                  `Sent to ${r.label}`,
                )
              : deliveryAction(
                  'telegram/retry',
                  { runId: r.runId, chatId: r.chatId },
                  `Retried ${r.label}`,
                ))
          }
        />
      ),
    },
  ];
  const pendingCols: Column<AccessRow>[] = [
    { label: 'Person', render: (r) => <Who r={r} /> },
    WHEN,
    {
      label: '',
      render: (r) => (
        <div className="row-actions">
          <Act
            enabled={canManage}
            label="Approve"
            cls="primary"
            onClick={() => void changeAccess('approve', r.chatId, `Approved ${r.label}.`)}
          />
          <Act
            enabled={canManage}
            label="Reject"
            cls="danger"
            onClick={() => void changeAccess('reject', r.chatId, `Rejected ${r.label}.`)}
          />
        </div>
      ),
    },
  ];
  const memberCols: Column<MemberRow>[] = [
    { label: 'Person', render: (r) => <Who r={r} /> },
    WHEN,
    {
      label: '',
      render: (r) =>
        r.owner ? (
          <span className="muted small">always allowed</span>
        ) : (
          <Act
            enabled={canManage}
            label="Remove"
            cls="danger"
            onClick={() => void changeAccess('remove', r.chatId, `Removed ${r.label}.`)}
          />
        ),
    },
  ];
  const deniedCols: Column<{ chatId: string }>[] = [
    { label: 'Chat id', render: (r) => r.chatId },
    {
      label: '',
      render: (r) => (
        <Act
          enabled={canManage}
          label="Allow again"
          onClick={() => void changeAccess('approve', r.chatId, `Approved ${r.chatId}.`)}
        />
      ),
    },
  ];

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const id = addId.trim();
    if (id)
      void changeAccess('approve', id, `Approved ${id}.`).then((ok) => {
        if (ok) setAddId('');
      });
  };

  return (
    <>
      <div>
        {note && note[1] ? (
          <div className={note[0] === 'error' ? 'banner inline' : 'note-ok'}>{note[1]}</div>
        ) : null}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Missed reports</h2>
          <span className="hint">last 6 hours</span>
          <span className="row-actions">
            <button
              type="button"
              className="btn"
              disabled={!missed || !canManage || !missed.rows.some((r) => r.state !== 'not_queued')}
              onClick={() => void deliveryAction('telegram/retry', {}, 'Retried all missed')}
            >
              Retry all missed
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!missed || !canManage || missed.mode !== 'live'}
              onClick={() =>
                void deliveryAction('telegram/send', {}, 'Sent latest report to everyone')
              }
            >
              Send latest report to everyone
            </button>
          </span>
        </div>
        <div className="table-wrap">
          {missed ? (
            <Table
              cols={missedCols}
              rows={missed.rows}
              empty={
                missed.mode === 'live'
                  ? 'No missed reports in the last 6 hours.'
                  : `Telegram is ${missed.mode}: nothing is sent.`
              }
              rowKey={(r, i) => `${r.runId}-${r.chatId}-${i}`}
            />
          ) : null}
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Waiting for approval</h2>
            <span className="hint">people who messaged the bot</span>
          </div>
          <div className="table-wrap">
            {error ? (
              <LoadError error={error} />
            ) : a ? (
              <Table
                cols={pendingCols}
                rows={a.pending}
                empty="No pending requests."
                rowKey={(r) => r.chatId}
              />
            ) : (
              <SkeletonTable rows={3} />
            )}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Members</h2>
            <span className="hint">get the hourly summary and bot commands</span>
          </div>
          <div className="table-wrap">
            {a ? (
              <Table
                cols={memberCols}
                rows={[
                  { chatId: a.owner || '—', label: 'Owner', at: null, owner: true },
                  ...a.members,
                ]}
                empty="No members."
                rowKey={(r, i) => `${r.chatId}-${i}`}
              />
            ) : (
              <SkeletonTable rows={3} />
            )}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Add by chat id</h2>
            <span className="hint">they must also open the bot and press Start</span>
          </div>
          <form className="inline-form" autoComplete="off" onSubmit={onAdd}>
            <input
              inputMode="numeric"
              pattern="-?[0-9]{3,20}"
              placeholder="Telegram chat id"
              aria-label="Telegram chat id"
              required
              value={addId}
              onChange={(e) => setAddId(e.target.value)}
            />
            <button type="submit" className="btn primary">
              Approve
            </button>
          </form>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Rejected</h2>
            <span className="hint">ignored until allowed again</span>
          </div>
          <div className="table-wrap">
            {a ? (
              <Table
                cols={deniedCols}
                rows={a.denied.map((chatId) => ({ chatId }))}
                empty="Nobody rejected."
                rowKey={(r) => r.chatId}
              />
            ) : (
              <SkeletonTable rows={2} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
