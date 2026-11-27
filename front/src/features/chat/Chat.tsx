// Claude chat (owner, chat:use): the analyst desk (risk manager, pro trader, market data analyst)
// answering from the panel's stored data and the current strategy. Read-only: it cannot change
// anything. A reply is written in the background; this page polls. Claude's text is untrusted and
// rendered as React text only.
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { LoadError } from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtTime } from '../../lib/format';

import './chat.css';
import {
  CHAT_EFFORTS,
  type ChatConversation,
  type ChatEffort,
  type ChatListItem,
  type ChatStatus,
} from './types';

const EFFORT_TEXT: Record<ChatEffort, string> = {
  low: 'Low: quick',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max: deepest',
};

export default function Chat() {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [list, setList] = useState<ChatListItem[]>([]);
  const [conv, setConv] = useState<ChatConversation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ChatEffort>('high');
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gen = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    try {
      setList(await api<ChatListItem[]>('chat/conversations'));
    } catch (e) {
      setError(e);
    }
  }, []);

  /** Load one conversation; keep polling every 2.5 s while a reply is being written. */
  const open = useCallback(
    async (id: string) => {
      const g = ++gen.current;
      clearTimeout(timer.current);
      const tick = async () => {
        let c: ChatConversation;
        try {
          c = await api<ChatConversation>(`chat/conversations/${id}`);
        } catch (e) {
          if (g === gen.current) setError(e);
          return;
        }
        if (g !== gen.current) return;
        setError(null);
        setConv(c);
        if (c.running) timer.current = setTimeout(() => void tick(), 2500);
        else void loadList();
      };
      await tick();
    },
    [loadList],
  );

  useEffect(() => {
    void (async () => {
      try {
        const s = await api<ChatStatus>('chat/status');
        setStatus(s);
        setModel(s.defaultModel);
        setEffort(s.defaultEffort);
        await loadList();
      } catch (e) {
        setError(e);
      }
    })();
    return () => {
      gen.current++;
      clearTimeout(timer.current);
    };
  }, [loadList]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [conv?.messages.length, conv?.running]);

  const picked = status?.models.find((m) => m.id === model);
  const quota =
    conv?.quota ??
    (status ? { max: status.maxMessages, used: 0, remaining: status.maxMessages } : null);
  const blocked = !status?.available || sending || !!conv?.running || (quota?.remaining ?? 0) <= 0;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const message = text.trim();
    if (!message || blocked) return;
    setSending(true);
    try {
      const c = await apiPost<ChatConversation>('chat/messages', {
        ...(conv ? { conversationId: conv.id } : {}),
        message,
        model,
        effort,
      });
      setText('');
      setConv(c);
      void open(c.id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const newChat = () => {
    gen.current++;
    clearTimeout(timer.current);
    setConv(null);
    setText('');
  };

  if (error && !status) return <LoadError error={error} />;
  if (!status)
    return (
      <div className="route-loading" role="status">
        <span className="sr-only">Loading the chat…</span>
      </div>
    );

  return (
    <div className="chat">
      <aside className="panel chat-side">
        <button type="button" className="btn primary" onClick={newChat}>
          New conversation
        </button>
        <ul className="chat-list">
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`chat-item${conv?.id === c.id ? ' on' : ''}`}
                onClick={() => void open(c.id)}
              >
                <span className="chat-item-title">{c.title}</span>
                <span className="muted small">{`${c.quota.used}/${c.quota.max} · ${fmtAgo(c.updatedAt)}`}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="muted small">No conversations yet.</li>}
        </ul>
      </aside>

      <section className="panel chat-main">
        <div className="panel-head">
          <h3>Analyst desk</h3>
          <span className="hint">
            {quota ? `${quota.remaining} of ${quota.max} messages left` : ''}
          </span>
        </div>
        <p className="muted small">
          Risk manager, pro trader and market data analyst in one. It reads this panel&apos;s stored
          data and the current strategy ({status.strategy.versions.ruleset}, ranking{' '}
          {status.strategy.versions.ranking}). Read-only: it cannot change data. An AI opinion for
          your own review, not a trading signal.
        </p>
        {!status.available && (
          <div className="error">{status.reason ?? 'The chat is unavailable.'}</div>
        )}
        {conv?.strategyChanged && (
          <div className="chat-notice">
            The strategy was updated since this conversation began. New replies use the current
            rules; earlier answers may be outdated.
          </div>
        )}
        {error ? <LoadError error={error} /> : null}

        <div className="chat-thread" aria-live="polite">
          {!conv && (
            <div className="empty">
              Ask about the review queue, a coin, the market regime, the risk of a setup or how a
              rule works.
            </div>
          )}
          {conv?.messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-meta muted small">
                {m.role === 'user' ? 'You' : 'Desk'}
                {m.role === 'assistant' && m.model ? ` · ${m.model}` : ''} · {fmtTime(m.createdAt)}
              </div>
              {m.status === 'RUNNING' ? (
                <div className="chat-body muted">Claude is reading the data…</div>
              ) : m.status === 'FAILED' ? (
                <div className="chat-body error">{m.errorMessage ?? 'The reply failed.'}</div>
              ) : (
                <div className="chat-body">{m.content}</div>
              )}
              {m.role === 'assistant' && m.toolCalls.length > 0 && (
                <div className="chat-tools muted small">
                  {`Read: ${[...new Set(m.toolCalls.map((t) => t.name))].join(', ')}`}
                </div>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <form className="chat-compose" onSubmit={(e) => void submit(e)}>
          <div className="chat-options">
            <label className="select-field">
              <span className="muted small">Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {status.models.map((m) => (
                  <option key={m.id} value={m.id}>{`${m.label} · ${m.note}`}</option>
                ))}
              </select>
            </label>
            <label className="select-field">
              <span className="muted small">Effort</span>
              <select
                value={effort}
                disabled={!picked?.effort}
                onChange={(e) => setEffort(e.target.value as ChatEffort)}
                title={
                  picked?.effort ? 'How hard Claude thinks' : 'This model has no effort setting'
                }
              >
                {CHAT_EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {EFFORT_TEXT[x]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            maxLength={4000}
            rows={3}
            disabled={(quota?.remaining ?? 0) <= 0}
            placeholder={
              (quota?.remaining ?? 0) <= 0
                ? 'This conversation used all its messages. Start a new one.'
                : 'Ask the desk… (Enter sends, Shift+Enter for a new line)'
            }
            aria-label="Message"
          />
          <button type="submit" className="btn primary" disabled={blocked || !text.trim()}>
            {sending || conv?.running ? 'Waiting…' : 'Send'}
          </button>
        </form>
      </section>
    </div>
  );
}
