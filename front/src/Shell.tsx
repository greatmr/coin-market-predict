// The signed-in layout: rail, header, banners, the routed page, and the app-wide timers. Reads only
// the NestJS JSON API. The live TradingView chart is a sandboxed cross-origin iframe on the coin
// page, never a script in this page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useMatches, useNavigate } from 'react-router';

import { ErrorBoundary } from './components/ErrorBoundary';
import { DialogHost, Tip } from './components/Feedback';
import { Icon } from './components/icons';
import Palette from './features/palette/Palette';
import { api, apiPost, errorMessage } from './lib/api';
import { ROLE_TEXT } from './lib/constants';
import { hideTip, toast } from './lib/feedback';
import { fmtClock, fmtInt, setDisplayTimezone, tz } from './lib/format';
import { SECTIONS, type Section, type SectionKey, coinPath } from './lib/routes';
import { AppProvider, type AppState, useApp, useDerived, useOverviewPoll } from './state/app';
import { useSession } from './state/session';
import type { AppConfig, OperateResult, Overview, Permission, User } from './types/api';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function useTheme() {
  const [mode, setMode] = useState<string>(() => {
    try {
      return localStorage.getItem('theme') || 'auto';
    } catch {
      return 'auto';
    }
  });
  useEffect(() => {
    if (mode === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
  }, [mode]);
  const cycle = () => {
    const next = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* storage unavailable */
    }
    setMode(next);
    toast(`Theme: ${next}`);
  };
  return [mode, cycle] as const;
}

/** Signed-in gate: sends the browser to sign-in or the password change, then loads /api/config. */
export function Shell() {
  const session = useSession();
  const loc = useLocation();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);

  useEffect(() => {
    if (session.status !== 'ready' || cfg) return;
    api<AppConfig>('config')
      .then((c) => {
        setDisplayTimezone(c.timezone);
        setCfg(c);
      })
      .catch((e) => setCfgError(errorMessage(e)));
  }, [session.status, cfg]);

  const next = encodeURIComponent(loc.pathname + loc.search);
  if (session.status === 'anon') return <Navigate to={`/login?next=${next}`} replace />;
  if (session.status === 'change') return <Navigate to={`/change-password?next=${next}`} replace />;
  if (session.status === 'error' || cfgError)
    return (
      <div className="boot-error banner" role="status">
        The dashboard could not load: {session.notice || cfgError}. Check that the API is running,
        then reload.
      </div>
    );
  if (session.status === 'loading' || !session.me || !cfg)
    return (
      <div className="boot" aria-busy="true">
        <div className="skeleton">
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  return <SignedIn me={session.me} cfg={cfg} />;
}

function SignedIn({ me, cfg }: { me: User; cfg: AppConfig }) {
  const session = useSession();
  const navigate = useNavigate();
  const loc = useLocation();
  const matches = useMatches();
  const { overview, lbank, dataVersion, refresh } = useOverviewPoll(true);
  const derived = useDerived(me, cfg);
  const { can } = derived;
  const [navCounts, setNavCounts] = useState<Record<string, number>>({});
  const [pageNotes, setPageNotes] = useState<Record<string, string>>({});
  const [pageHead, setPageHead] = useState<{ title: string; sub: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themeMode, cycleTheme] = useTheme();
  const paletteReturn = useRef<Element | null>(null);

  const allowed = useCallback((s: Section) => !s.permission || can(s.permission), [can]);
  const handle = (matches[matches.length - 1]?.handle ?? {}) as {
    section?: SectionKey;
    permission?: Permission;
  };
  const section = handle.section ? SECTIONS.find((s) => s.key === handle.section) : undefined;

  /* ---------- First load and timers ---------- */

  useEffect(() => {
    refresh(true).catch((e) => toast(`Could not load the overview: ${errorMessage(e)}`, 'error'));
    if (me.permissions.includes('telegram:manage'))
      api<{ pending: unknown[]; missingCount?: number }>('telegram/access')
        .then((a) =>
          setNavCounts((c) => ({ ...c, access: a.pending.length + (a.missingCount || 0) })),
        )
        .catch(() => undefined);
  }, [refresh, me.permissions]);

  useEffect(() => {
    const id = setInterval(() => {
      refresh().catch((e) => toast(`Could not reach the API: ${errorMessage(e)}`, 'error'));
    }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Once the scheduled slot has passed by 5 s, refresh once so the new run shows up.
  const nextRunAt = overview?.schedule?.enabled ? overview.schedule.nextRunAt : null;
  const running = overview?.latestRun?.status === 'running';
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (running || !nextRunAt || firedFor.current === nextRunAt) return undefined;
    const wait = Math.max(0, new Date(nextRunAt).getTime() + 5_000 - Date.now());
    const id = setTimeout(() => {
      firedFor.current = nextRunAt;
      refresh().catch(() => undefined);
    }, wait);
    return () => clearTimeout(id);
  }, [running, nextRunAt, refresh]);

  /* ---------- Document-level effects ---------- */

  const title = pageHead?.title ?? section?.title ?? 'Coins Predicts';
  useEffect(() => {
    document.title =
      !section || section.key === 'overview'
        ? pageHead
          ? `${pageHead.title} · Coins Predicts`
          : 'Coins Predicts'
        : `${title} · Coins Predicts`;
  }, [section, title, pageHead]);
  useEffect(() => {
    hideTip();
    setPageHead(null);
  }, [loc.pathname]);

  const openPalette = useCallback(() => {
    paletteReturn.current = document.activeElement;
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    const back = paletteReturn.current;
    if (back instanceof HTMLElement && document.contains(back)) setTimeout(() => back.focus(), 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      const typing = target?.closest?.('input, textarea, select, [contenteditable]');
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
        return;
      }
      if (e.key === 'Escape' && paletteOpen) closePalette();
    };
    const onScroll = () => hideTip();
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll);
    };
  }, [paletteOpen, openPalette, closePalette]);

  /* ---------- Context ---------- */

  const setNavCount = useCallback(
    (key: string, n: number) => setNavCounts((c) => (c[key] === n ? c : { ...c, [key]: n })),
    [],
  );
  const setPageNote = useCallback(
    (key: string, text: string) =>
      setPageNotes((c) => (c[key] === text ? c : { ...c, [key]: text })),
    [],
  );
  const openCoin = useCallback(
    (cmcId: number, batchId?: string | null) => navigate(coinPath(cmcId, { batch: batchId })),
    [navigate],
  );

  const ctx = useMemo<AppState>(
    () => ({
      me,
      setMe: session.setMe,
      cfg,
      overview,
      lbank,
      dataVersion,
      refresh,
      ...derived,
      setNavCount,
      setPageNote,
      setPageHead,
      openCoin,
      openPalette,
      signOut: async () => {
        await session.signOut();
        navigate('/login', { replace: true });
      },
    }),
    [
      me,
      session,
      cfg,
      overview,
      lbank,
      dataVersion,
      refresh,
      derived,
      setNavCount,
      setPageNote,
      openCoin,
      openPalette,
      navigate,
    ],
  );

  const counts: Partial<Record<SectionKey, number | undefined>> = useMemo(() => {
    const c = overview?.scan?.counts ?? {};
    return {
      queue: c.queue ?? 0,
      eligible: c.eligible ?? 0,
      needs_review: c.needsReview ?? 0,
      excluded: c.excluded ?? 0,
      forward: navCounts.forward,
      access: navCounts.access ?? 0,
    };
  }, [overview, navCounts]);

  const visible = SECTIONS.filter(allowed);
  const onRailKey = (e: React.KeyboardEvent<HTMLElement>) => {
    const dir = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = visible.findIndex((s) => s.key === section?.key);
    const nextS = visible[(i + dir + visible.length) % visible.length]!;
    navigate(nextS.path);
    setTimeout(() => document.getElementById(`t-${nextS.key}`)?.focus(), 0);
  };

  const forbidden = section && !allowed(section);
  const sub = pageHead?.sub ?? section?.sub ?? '';
  const note = section ? pageNotes[section.key] : '';

  return (
    <AppProvider value={ctx}>
      <div className="aurora" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <nav className="rail" aria-label="Dashboard sections">
        <NavLink className="mark" to="/" aria-label="Coins Predicts overview">
          <Icon name="mark" viewBox="0 0 32 32" />
        </NavLink>
        <div className="rail-items" onKeyDown={onRailKey}>
          {visible.map((s) => (
            <NavLink
              key={s.key}
              id={`t-${s.key}`}
              to={s.path}
              end={s.path === '/'}
              className={s.key === 'account' ? 'rail-link rail-account' : 'rail-link'}
              data-label={s.label}
            >
              <Icon name={s.key} />
              <span>{s.label}</span>
              {s.counted ? (
                <b className="count">{counts[s.key] === undefined ? '' : fmtInt(counts[s.key])}</b>
              ) : null}
            </NavLink>
          ))}
        </div>
        <button
          className="rail-theme"
          type="button"
          aria-label={`Color theme: ${themeMode}`}
          title={`Theme: ${themeMode}`}
          onClick={cycleTheme}
        >
          <Icon name="theme" />
        </button>
      </nav>

      <div className="shell">
        <header className="top">
          <div className="title-block">
            <h1>{title}</h1>
            <p className="page-sub">
              {sub}
              {note ? ` ${note}` : ''}
            </p>
          </div>
          <div className="top-actions">
            <span className="badges">
              <span
                className={`badge ${cfg.isLiveData ? 'live' : 'fixture'}`}
                title={`Telegram ${cfg.telegramMode}; scheduler ${cfg.schedulerEnabled ? 'on' : 'off'}`}
              >
                <span className="pulse-dot" aria-hidden="true" />
                {cfg.isLiveData ? cfg.providerName : 'Synthetic fixture data'}
              </span>
              <span className="badge quiet">{cfg.strategy.rulesetVersion}</span>
            </span>
            <button
              className="search-btn"
              type="button"
              aria-haspopup="dialog"
              onClick={openPalette}
            >
              <Icon name="search" />
              <span>Find a coin</span>
              <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <UserMenu me={me} />
          </div>
        </header>

        <Banner overview={overview} />

        <main>
          {forbidden ? (
            <div className="panel">
              <h2>Not available for your role</h2>
              <p className="muted small">
                Ask an owner if you need access to {section.title.toLowerCase()}.
              </p>
            </div>
          ) : (
            <ErrorBoundary label="This page" resetKeys={[loc.pathname]}>
              {/* `.tab` spaces the page's blocks (16 px); the id scopes page-specific CSS. */}
              <section
                id={`tab-${section?.key ?? (loc.pathname.startsWith('/coins/') ? 'coin' : 'page')}`}
                className="tab"
              >
                <Outlet />
              </section>
            </ErrorBoundary>
          )}
        </main>
        <footer>
          {`${cfg.attribution ? `${cfg.attribution}. ` : ''}Times in ${tz()}, stored in UTC. Research screening only: the review queue is a list for human chart review, never a buy signal, and no order is ever placed.`}
        </footer>
      </div>

      {paletteOpen ? <Palette onClose={closePalette} /> : null}
      <DialogHost />
      <Tip />
    </AppProvider>
  );
}

function UserMenu({ me }: { me: User }) {
  const { signOut } = useApp();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.user-menu')) setOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);
  return (
    <div className="user-menu">
      <button
        ref={chipRef}
        className="user-chip"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span className="avatar" aria-hidden="true">
          {me.username.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-text">
          <b>{me.username}</b>
          <small>{ROLE_TEXT[me.role][0]}</small>
        </span>
      </button>
      <div
        className="user-pop"
        role="menu"
        hidden={!open}
        onClick={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            chipRef.current?.focus();
          }
        }}
      >
        <NavLink role="menuitem" to="/account">
          My account
        </NavLink>
        <button role="menuitem" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

/** Synthetic-data notice, server banners, and "Retry crawl now" when the newest crawl failed. */
function Banner({ overview: ov }: { overview: Overview | null }) {
  const { live } = useApp();
  if (!ov) return null;
  const msgs = [...(ov.banners || [])];
  if (!live)
    msgs.unshift(
      'Synthetic fixture market: every coin, price and volume here is invented for testing.',
    );
  if (!msgs.length) return null;
  return (
    <div className="banner" role="status">
      {msgs.map((m, i) => (
        <div key={i}>{m}</div>
      ))}
      <CrawlRetryRow ov={ov} />
    </div>
  );
}

function CrawlRetryRow({ ov }: { ov: Overview }) {
  const { can, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const crawlFailed =
    ov.latestBatch?.status === 'FAILED' ||
    ['failed', 'interrupted'].includes(ov.latestRun?.status ?? '');
  if (!crawlFailed || !can('scan:operate') || ov.latestRun?.status === 'running') return null;
  const h = ov.sourceHealth;
  const note = !h
    ? null
    : h.state === 'open'
      ? `The source is paused after ${fmtInt(h.consecutiveFailures)} failed requests${h.reopensAt ? ` until ${fmtClock(h.reopensAt)}` : ''}. Retrying resets that timer.`
      : h.state === 'suspended'
        ? `The source is suspended (${h.suspendedReason || 'access denied'}). Resolve the cause, then run npm run cli -- source:reset.`
        : null;
  const retry = async () => {
    setBusy(true);
    try {
      const r = await apiPost<OperateResult>('pipeline/retry', {});
      if (r.ok)
        toast(
          `Crawl restarted for the ${fmtClock(r.slot)} slot${r.circuitReset ? '; source timer reset' : ''}.`,
        );
      else toast(`Crawl not restarted: ${r.reason}`, 'warning');
      await refresh(true);
    } catch (err) {
      toast(`Retry failed: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row-actions banner-actions">
      <button
        type="button"
        className="btn small primary"
        disabled={busy || h?.state === 'suspended'}
        title="Reset the source's failure timer and crawl the current hour again"
        onClick={retry}
      >
        {busy ? 'Starting…' : 'Retry crawl now'}
      </button>
      {note ? <span className="muted small">{note}</span> : null}
    </div>
  );
}
