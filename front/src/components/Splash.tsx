// The global loading screen (session and configuration, before any page): an illustration of the
// project — daily candles with the trend line drawing itself — instead of grey blocks. The same
// markup is in index.html, so it shows while the script downloads; keep the two in step.
const CANDLES: readonly (readonly [x: number, top: number, bottom: number, up: boolean])[] = [
  [18, 58, 78, false],
  [40, 54, 74, true],
  [62, 60, 76, false],
  [84, 40, 66, true],
  [106, 44, 60, false],
  [128, 22, 50, true],
];

export function SplashArt() {
  return (
    <svg className="splash-art" viewBox="0 0 160 96" aria-hidden="true">
      <path className="splash-grid" d="M8 86h144M8 62h144M8 38h144" />
      {CANDLES.map(([x, top, bottom, up]) => (
        <g key={x} className={`splash-candle ${up ? 'up' : 'down'}`}>
          <path d={`M${x} ${top - 6}V${bottom + 6}`} />
          <rect x={x - 5} y={top} width="10" height={bottom - top} rx="2" />
        </g>
      ))}
      <path className="splash-line" d="M8 74L40 62L62 68L84 46L106 52L128 28L152 18" />
      <circle className="splash-dot" cx="152" cy="18" r="4" />
    </svg>
  );
}

export default function Splash({ text = 'Loading the screen…' }: { text?: string }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <SplashArt />
      <b className="splash-title">Coins Predicts</b>
      <span className="splash-text">{text}</span>
    </div>
  );
}
