// The signed-in layout: rail, header, banners, the routed page, and the app-wide timers. Reads only
// the NestJS JSON API. The live TradingView chart is a sandboxed cross-origin iframe on the coin
// page, never a script in this page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useMatches, useNavigate } from 'react-router';

import { ErrorBoundary } from './components/ErrorBoundary';
import { DialogHost, Tip } from './components/Feedback';
import Splash from './components/Splash';
import { Icon } from './components/icons';
import Palette from './features/palette/Palette';
import { api, apiPost, errorMessage } from './lib/api';
import { ROLE_TEXT } from './lib/constants';
import { hideTip, toast } from './lib/feedback';
import { fmtClock, fmtInt, setDisplayTimezone, tz } from './lib/format';
import { setRailCollapsed, useRailCollapsed } from './lib/prefs';
import { SECTIONS, SECTION_GROUPS, type Section, type SectionKey, coinPath } from './lib/routes';
import { AppProvider, type AppState, useApp, useDerived, useOverviewPoll } from './state/app';
import { useSession } from './state/session';
import type { AppConfig, OperateResult, Overview, Permission, User } from './types/api';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const TABLET = '(min-width: 721px) and (max-width: 1100px)';

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setOn(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return on;
}

/**
 * Collapsible sidebar. Desktop: full by default, collapses to icons, and the choice is remembered (also set on Preferences).
 * Tablet: icons by default; the toggle opens the full sidebar over the page until a link is
 * chosen, Escape is pressed or the page behind is clicked. Phones keep the bottom bar.
 */
function useRail(pathname: string) {
  const tablet = useMedia(TABLET);
  const collapsed = useRailCollapsed();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname, tablet]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const toggle = () => {
    if (tablet) setOpen((o) => !o);
    else setRailCollapsed(!collapsed);
  };
  return {
    collapsed,
    open,
    close: () => setOpen(false),
    toggle,
    expanded: tablet ? open : !collapsed,
  };
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
  if (session.status === 'loading' || !session.me || !cfg) return <Splash />;
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
  const rail = useRail(loc.pathname);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [loc.pathname]);
  // A new page starts at its top (query changes such as filters or pages keep the position).
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [loc.pathname]);
  // Online: the browser has a network and the last API poll answered.
  const [netOnline, setNetOnline] = useState(() => navigator.onLine);
  const [apiOk, setApiOk] = useState(true);
  useEffect(() => {
    const on = () => setNetOnline(true);
    const off = () => setNetOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const online = netOnline && apiOk;
  const paletteReturn = useRef<Element | null>(null);

  const allowed = useCallback((s: Section) => !s.permission || can(s.permission), [can]);
  const handle = (matches[matches.length - 1]?.handle ?? {}) as {
    section?: SectionKey;
    permission?: Permission;
  };
  const section = handle.section ? SECTIONS.find((s) => s.key === handle.section) : undefined;

  /* ---------- First load and timers ---------- */

  const [legacyRetired, setLegacyRetired] = useState(false);
  useEffect(() => {
    api<{ state: string }>('forward/legacy')
      .then((l) => setLegacyRetired(l.state === 'retired'))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh(true).then(
      () => setApiOk(true),
      (e) => {
        setApiOk(false);
        toast(`Could not load the overview: ${errorMessage(e)}`, 'error');
      },
    );
    if (me.permissions.includes('telegram:manage'))
      api<{ pending: unknown[]; missingCount?: number }>('telegram/access')
        .then((a) =>
          setNavCounts((c) => ({ ...c, access: a.pending.length + (a.missingCount || 0) })),
        )
        .catch(() => undefined);
  }, [refresh, me.permissions]);

  useEffect(() => {
    const id = setInterval(() => {
      refresh().then(
        () => setApiOk(true),
        (e) => {
          setApiOk(false);
          toast(`Could not reach the API: ${errorMessage(e)}`, 'error');
        },
      );
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
      observation: navCounts.observation,
      forward: navCounts.forward,
      access: navCounts.access ?? 0,
    };
  }, [overview, navCounts]);

  // The legacy forward test leaves the navigation once it is retired (its page stays reachable).
  const visible = SECTIONS.filter(allowed).filter((s) => s.key !== 'forward' || !legacyRetired);
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

      {rail.open ? <div className="rail-scrim" aria-hidden="true" onClick={rail.close} /> : null}
      <nav
        className={`rail${rail.collapsed ? ' collapsed' : ''}${rail.open ? ' open' : ''}`}
        aria-label="Dashboard sections"
      >
        <div className="rail-top">
          <NavLink className="mark" to="/" aria-label="Coins Predicts overview">
            <Icon name="mark" viewBox="0 0 32 32" />
          </NavLink>
        </div>
        {/* On the sidebar's right edge, level with the logo. */}
        <button
          className={`rail-toggle${rail.expanded ? '' : ' closed'}`}
          type="button"
          aria-expanded={rail.expanded}
          aria-label={rail.expanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
          onClick={rail.toggle}
        >
          <Icon name="chevron" />
        </button>
        <div className="rail-items" onKeyDown={onRailKey}>
          {SECTION_GROUPS.map(([group, heading]) => {
            const items = visible.filter((s) => s.group === group);
            if (!items.length) return null;
            return (
              <div key={group} className={`rail-group rail-group-${group}`}>
                <span className="rail-heading">{heading}</span>
                {items.map((s) => (
                  <RailLink key={s.key} s={s} count={counts[s.key]} me={me} online={online} />
                ))}
              </div>
            );
          })}
          <button
            type="button"
            className="rail-link rail-more"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            <Icon name="more" />
            <span>More</span>
          </button>
        </div>
        <div className="rail-foot">
          <button
            type="button"
            className="rail-link rail-signout has-tip"
            data-label="Sign out"
            onClick={() => void ctx.signOut()}
          >
            <Icon name="signout" />
            <span>Sign out</span>
          </button>
        </div>
      </nav>

      <div className={`shell${rail.collapsed ? ' rail-collapsed' : ''}`}>
        <header className="top">
          <div className="top-search">
            <button
              className="search-btn"
              type="button"
              aria-haspopup="dialog"
              onClick={openPalette}
            >
              <Icon name="search" />
              <span>Find a coin by symbol, name or CMC id</span>
              <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
          </div>
          <div className="title-block">
            <h1>{title}</h1>
            <p className="page-sub">
              {sub}
              {note ? ` ${note}` : ''}
            </p>
          </div>
        </header>

        <Banner overview={overview} />

        <main tabIndex={-1}>
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
                key={loc.pathname}
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

      {moreOpen ? (
        <MoreSheet
          sections={visible.filter((s) => !s.primary)}
          me={me}
          online={online}
          counts={counts}
          signOut={() => void ctx.signOut()}
          onClose={() => setMoreOpen(false)}
        />
      ) : null}
      <BackToTop />
      {paletteOpen ? <Palette onClose={closePalette} /> : null}
      <DialogHost />
      <Tip />
    </AppProvider>
  );
}

/**
 * One sidebar entry: icon and label (the label is a tooltip while the sidebar shows icons).
 * Preferences shows the signed-in user's avatar with an online / offline dot.
 */
function RailLink({
  s,
  count,
  me,
  online,
}: {
  s: Section;
  count: number | undefined;
  me: User;
  online: boolean;
}) {
  const account = s.key === 'account';
  const role = ROLE_TEXT[me.role][0];
  const state = online ? 'Online' : 'Offline';
  return (
    <NavLink
      id={`t-${s.key}`}
      to={s.path}
      end={s.path === '/'}
      className={`rail-link has-tip${s.primary ? ' primary' : ''}${account ? ' rail-account' : ''}`}
      data-label={account ? `${s.label} · ${me.username} · ${state}` : s.label}
      aria-label={
        account
          ? `${s.label}: ${me.username}, ${role}, ${state === 'Online' ? 'online' : 'offline: the API cannot be reached'}`
          : undefined
      }
    >
      {account ? (
        <span className={`avatar ${me.role}`} aria-hidden="true">
          <Icon name="account" />
          <i className={`presence ${online ? 'on' : 'off'}`} />
        </span>
      ) : (
        <Icon name={s.key} />
      )}
      <span>{account ? `${s.label} · ${me.username}` : s.label}</span>
      {s.counted ? <b className="count">{count === undefined ? '' : fmtInt(count)}</b> : null}
    </NavLink>
  );
}

/** Phone: the sections that are not in the bottom bar, and sign out. */
function MoreSheet({
  sections,
  me,
  online,
  counts,
  signOut,
  onClose,
}: {
  sections: Section[];
  me: User;
  online: boolean;
  counts: Partial<Record<SectionKey, number | undefined>>;
  signOut: () => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Focus the sheet itself (no ring on the first button after a tap); Tab then walks the items.
    boxRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="more-sheet" role="dialog" aria-modal="true" aria-label="More sections">
      <div className="more-scrim" aria-hidden="true" onClick={onClose} />
      <div className="more-box" ref={boxRef} tabIndex={-1}>
        <div className="more-head">
          <b>More</b>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {SECTION_GROUPS.map(([group, heading]) => {
          const items = sections.filter((s) => s.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className="more-group">
              <span className="rail-heading">{heading}</span>
              {items.map((s) => (
                <RailLink key={s.key} s={s} count={counts[s.key]} me={me} online={online} />
              ))}
            </div>
          );
        })}
        <div className="more-actions">
          <button type="button" className="btn" onClick={signOut}>
            <Icon name="signout" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/** A "back to top" button once the page has scrolled well past the first screen. */
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const top = () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true });
  };
  return (
    <button
      type="button"
      className={`back-to-top${show ? ' show' : ''}`}
      aria-label="Back to top"
      title="Back to top"
      tabIndex={show ? 0 : -1}
      aria-hidden={!show}
      onClick={top}
    >
      <Icon name="up" />
    </button>
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
