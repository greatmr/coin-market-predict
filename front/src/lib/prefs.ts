// Per-browser display preferences (Preferences page, sidebar): colour theme and whether the desktop
// sidebar starts collapsed. Kept in localStorage (a convenience only: a private window or blocked
// storage falls back to the defaults). The theme is applied as soon as this module loads, so the
// first paint already has the right colours.
import { useSyncExternalStore } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export const THEME_MODES: readonly (readonly [ThemeMode, string])[] = [
  ['auto', 'Auto (system)'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
};

interface Prefs {
  theme: ThemeMode;
  railCollapsed: boolean;
}
const storedTheme = read('theme');
let prefs: Prefs = {
  theme: storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'auto',
  railCollapsed: read('rail') === 'collapsed',
};
const subs = new Set<() => void>();

function applyTheme(mode: ThemeMode) {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}
applyTheme(prefs.theme);

function update(next: Partial<Prefs>) {
  prefs = { ...prefs, ...next };
  for (const fn of subs) fn();
}
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};

export function setTheme(mode: ThemeMode) {
  write('theme', mode);
  applyTheme(mode);
  update({ theme: mode });
}
export function setRailCollapsed(collapsed: boolean) {
  write('rail', collapsed ? 'collapsed' : 'expanded');
  update({ railCollapsed: collapsed });
}

export const useTheme = (): ThemeMode =>
  useSyncExternalStore(
    subscribe,
    () => prefs.theme,
    () => prefs.theme,
  );
export const useRailCollapsed = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => prefs.railCollapsed,
    () => prefs.railCollapsed,
  );
