// Coin search (⌘K / Ctrl K / "/"). Rendered by the shell only while open; Escape and the shortcut
// are handled there. Picking a coin opens its page (/coins/:cmcId).
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { Icon } from '../../components/icons';
import { Logo } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useApp } from '../../state/app';

import type { AssetHit, AssetSearch } from '../sheets/types';

const START_HINT = 'Type a symbol, a name or a CMC id.';

export default function Palette({ onClose }: { onClose: () => void }) {
  const { openCoin } = useApp();
  const [items, setItems] = useState<AssetHit[]>([]);
  const [hint, setHint] = useState(START_HINT);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    return () => clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!items.length) return;
    listRef.current?.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  const show = (list: AssetHit[], h: string) => {
    setItems(list);
    setHint(h);
    setActive(0);
  };

  const search = async (q: string) => {
    const mine = ++seq.current;
    if (!q) return show([], START_HINT);
    try {
      const d = await api<AssetSearch>(`assets?search=${encodeURIComponent(q)}&limit=8`);
      if (mine === seq.current) show(d.assets || [], `No coin matches “${q}”.`);
    } catch (e) {
      if (mine === seq.current) show([], `Search failed: ${errorMessage(e)}`);
    }
  };

  const pick = (i: number) => {
    const a = items[i];
    if (!a) return;
    onClose();
    openCoin(a.cmcId);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      setActive((active - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    }
  };

  return (
    <div
      className="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Find a coin"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette-box">
        <label className="palette-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search by symbol, name or CMC id"
            autoComplete="off"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={items.length ? `pal-${active}` : undefined}
            onChange={(e) => {
              clearTimeout(timer.current);
              const q = e.target.value.trim();
              timer.current = setTimeout(() => void search(q), 180);
            }}
            onKeyDown={onKey}
          />
        </label>
        <ul
          ref={listRef}
          id="palette-list"
          className="palette-list"
          role="listbox"
          aria-label="Matching coins"
        >
          {items.length ? (
            items.map((a, i) => (
              <li
                key={a.cmcId}
                role="option"
                id={`pal-${i}`}
                aria-selected={i === active}
                onClick={() => pick(i)}
                onPointerEnter={() => setActive(i)}
              >
                <Logo cmcId={a.cmcId} size={24} />
                <div className="coin-text">
                  <b>{a.symbol}</b>
                  <span>{a.name}</span>
                </div>
                <span className="muted small">CMC {a.cmcId}</span>
              </li>
            ))
          ) : (
            <li className="palette-hint">{hint}</li>
          )}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
