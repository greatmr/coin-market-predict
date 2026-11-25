// The help (?) button: opens the "how it works" guide of a page or section in the modal box, so
// pages keep their tables and tiles and the explanations stay one click away.
import { infoDialog } from '../lib/feedback';

import { GUIDES, type Guide, type GuideKey } from './guides';

function GuideBody({ g }: { g: Guide }) {
  return (
    <div className="guide">
      <p className="guide-intro">{g.intro}</p>
      {g.sections.map((s) => (
        <section key={s.h}>
          <h3>{s.h}</h3>
          <ul>
            {s.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
      {g.doc ? <p className="muted small">{`Full rules: ${g.doc}`}</p> : null}
    </div>
  );
}

export const openGuide = (key: GuideKey) => {
  const g = GUIDES[key];
  void infoDialog(g.title, <GuideBody g={g} />, { wide: true });
};

export function HelpButton({ topic, className }: { topic: GuideKey; className?: string }) {
  const g = GUIDES[topic];
  return (
    <button
      type="button"
      className={`help-btn${className ? ` ${className}` : ''}`}
      aria-label={`${g.title}: how it works`}
      title="How it works"
      onClick={() => openGuide(topic)}
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}
