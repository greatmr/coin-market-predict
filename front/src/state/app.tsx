// App-wide state: the signed-in user, /api/config, the polled overview and LBank status, rail
// counts, page header overrides and the coin search. Pages read it with useApp().
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { api } from '../lib/api';
import { num } from '../lib/format';
import type { AppConfig, LbankStatus, Overview, Permission, User } from '../types/api';

export interface AppState {
  me: User;
  setMe: (u: User) => void;
  cfg: AppConfig;
  overview: Overview | null;
  lbank: LbankStatus | null;
  /** Changes when the latest scanned batch changes (or on a forced refresh): list pages reload. */
  dataVersion: number;
  refresh: (force?: boolean) => Promise<Overview>;
  can: (perm: Permission) => boolean;
  live: boolean;
  passLine: number;
  /** Rail badges reported by pages (forward test, Telegram). */
  setNavCount: (key: string, n: number) => void;
  /** Extra text after the page subtitle (the sheets add their batch and time). */
  setPageNote: (key: string, text: string) => void;
  /** Replaces the page title and subtitle while the calling page is shown (coin pages). */
  setPageHead: (head: { title: string; sub: string } | null) => void;
  /** Opens a coin's page (keeps the list's URL in history for the back button). */
  openCoin: (cmcId: number, batchId?: string | null) => void;
  openPalette: () => void;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp() outside the signed-in app');
  return ctx;
}
export const AppProvider = ({ value, children }: { value: AppState; children: ReactNode }) => (
  <AppContext.Provider value={value}>{children}</AppContext.Provider>
);

/**
 * The overview poll: refresh(force) reloads /api/overview and /api/lbank; dataVersion changes when
 * the latest scanned batch changes. While a run is in progress the overview is polled every 5 s.
 */
export function useOverviewPoll(enabled: boolean) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [lbank, setLbank] = useState<LbankStatus | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const lastBatch = useRef<string | null | undefined>(undefined);

  const refresh = useCallback(async (force = false) => {
    const [ov, lb] = await Promise.all([
      api<Overview>('overview'),
      api<LbankStatus>('lbank').catch(() => null),
    ]);
    setOverview(ov);
    setLbank(lb);
    const batch = ov.scan ? ov.scan.batchId : null;
    if (force || batch !== lastBatch.current) {
      lastBatch.current = batch;
      setDataVersion((v) => v + 1);
    }
    return ov;
  }, []);

  const running = overview?.latestRun?.status === 'running';
  useEffect(() => {
    if (!enabled || !running) return undefined;
    const id = setInterval(async () => {
      try {
        const ov = await refresh();
        if (ov.latestRun?.status !== 'running') await refresh(true);
      } catch {
        /* the 30 s tick reports API errors */
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [enabled, running, refresh]);

  return { overview, lbank, dataVersion, refresh };
}

/** Re-renders every `ms` and returns Date.now() (countdowns, "x min ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Permission helpers derived from the signed-in user and /api/config. */
export function useDerived(me: User | null, cfg: AppConfig | null) {
  return useMemo(
    () => ({
      can: (perm: Permission) => !!me && me.permissions.includes(perm),
      live: !!cfg?.isLiveData,
      passLine: num(cfg?.strategy.rules.passMultiple ?? null) || 1.5,
    }),
    [me, cfg],
  );
}
