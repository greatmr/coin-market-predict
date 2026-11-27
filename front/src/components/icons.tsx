// Line icons from the original dashboard markup (stroke styling comes from the stylesheet).
import type { InputHTMLAttributes, ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  mark: (
    <>
      <path d="M4 22c4 0 5-9 9-9s4 6 7 6 4-11 8-13" />
      <circle cx="28" cy="6" r="2.4" />
    </>
  ),
  overview: (
    <>
      <path d="M4 13a8 8 0 1 1 16 0" />
      <path d="M12 13l4-4" />
      <path d="M4 18h16" />
    </>
  ),
  queue: (
    <>
      <path d="M5 19V9" />
      <path d="M10 19V5" />
      <path d="M15 19v-7" />
      <path d="M20 19V3" />
    </>
  ),
  // LBank Spot observation: two 1-minute candles (wick + body).
  observation: (
    <>
      <path d="M8 3v4" />
      <rect x="5.5" y="7" width="5" height="8" rx="1" />
      <path d="M8 15v5" />
      <path d="M16 5v6" />
      <rect x="13.5" y="11" width="5" height="6" rx="1" />
      <path d="M16 17v3" />
    </>
  ),
  forward: (
    <>
      <path d="M4 18l5-6 4 3 7-9" />
      <path d="M15 6h5v5" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  batches: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  access: <path d="M21 4L3 11l6 2 2 6 3-4 4 3z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </>
  ),
  theme: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" className="fill" />
    </>
  ),
  more: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),
  signout: (
    <>
      <path d="M14 5h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4" />
      <path d="M10 16l-4-4 4-4" />
      <path d="M6 12h10" />
    </>
  ),
  up: (
    <>
      <path d="M12 19V6" />
      <path d="M6.5 11.5L12 6l5.5 5.5" />
    </>
  ),
  chevron: <path d="M14.5 6.5L9 12l5.5 5.5" />,
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9 4.5v15" />
      <path d="M15.5 10l-2 2 2 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
};

export function Icon({ name, viewBox = '0 0 24 24' }: { name: string; viewBox?: string }) {
  return (
    <svg viewBox={viewBox} aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** The search field used in list toolbars: `<label class="search-field">` with the icon and an input. */
export function SearchField({
  placeholder = 'Symbol, name or CMC id',
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className="search-field">
      <Icon name="search" />
      <input
        type="search"
        className={className}
        placeholder={placeholder}
        aria-label={label}
        {...rest}
      />
    </label>
  );
}
