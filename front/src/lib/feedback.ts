// Toasts, the chart tooltip and the small modal dialog are app-wide singletons: tiny external
// stores, so any component or async handler can call toast() / showTip() / dialog(); the hosts in
// components/Feedback.tsx render them.
import { type ReactNode, useSyncExternalStore } from 'react';

interface Store<T> {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (fn: () => void) => () => void;
}
function store<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
const useStore = <T>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.get, s.get);

/* ---------- Toasts ---------- */

export type ToastKind = 'ok' | 'warning' | 'error';
export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  out: boolean;
}
const toasts = store<ToastItem[]>([]);
let toastSeq = 0;
export function toast(text: string, kind: ToastKind = 'ok'): void {
  const id = ++toastSeq;
  toasts.set((list) => [...list, { id, text, kind, out: false }]);
  setTimeout(
    () => {
      toasts.set((list) => list.map((t) => (t.id === id ? { ...t, out: true } : t)));
      setTimeout(() => toasts.set((list) => list.filter((t) => t.id !== id)), 300);
    },
    kind === 'error' ? 8000 : 4500,
  );
}
export const useToasts = () => useStore(toasts);

/* ---------- Tooltip (charts) ---------- */

export interface TipState {
  content: ReactNode;
  x: number;
  y: number;
}
const tip = store<TipState | null>(null);
/** Shows React content next to the pointer (client coordinates); the host keeps it on screen. */
export function showTip(content: ReactNode, x: number, y: number): void {
  tip.set({ content, x, y });
}
export function hideTip(): void {
  if (tip.get() !== null) tip.set(null);
}
export const useTip = () => useStore(tip);

/* ---------- Dialog ---------- */

export interface DialogOptions {
  title: string;
  /** React content with named, uncontrolled inputs (read through the FormData in onSubmit). */
  body: ReactNode;
  ok?: string;
  danger?: boolean;
  /** Runs on submit; a thrown error is shown in the dialog. */
  onSubmit: (data: FormData, form: HTMLFormElement) => Promise<void> | void;
}
export interface DialogState extends Required<Omit<DialogOptions, 'onSubmit'>> {
  onSubmit: DialogOptions['onSubmit'];
  close: (done: boolean) => void;
}
const dialogs = store<DialogState | null>(null);
/** A small modal form. Resolves true after onSubmit succeeds, false when cancelled. */
export function dialog({
  title,
  body,
  ok = 'OK',
  danger = false,
  onSubmit,
}: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    dialogs.set({
      title,
      body,
      ok,
      danger,
      onSubmit,
      close: (v) => {
        dialogs.set(null);
        resolve(v);
      },
    });
  });
}
export const useDialog = () => useStore(dialogs);
