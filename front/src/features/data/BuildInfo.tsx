// The builds being served: the commit of this dashboard bundle and the one the API reports on
// /healthz, so the code, the served UI and the API can be matched after a deploy.
import { useEffect, useState } from 'react';

import { UI_BUILD_COMMIT, healthUrl } from '../../lib/config';

const short = (c: string) => (/^[0-9a-f]{12,}$/.test(c) ? c.slice(0, 12) : c);

export default function BuildInfo() {
  const [api, setApi] = useState<{ commit: string; builtAt: string } | null>(null);
  useEffect(() => {
    fetch(healthUrl(), { cache: 'no-store', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { build?: { commit?: string; builtAt?: string } } | null) => {
        if (j?.build?.commit) setApi({ commit: j.build.commit, builtAt: j.build.builtAt ?? '' });
      })
      .catch(() => undefined);
  }, []);
  const differ = !!api && api.commit !== UI_BUILD_COMMIT;
  return (
    <p className="muted small" title={api?.builtAt ? `API image built ${api.builtAt}` : undefined}>
      {`Build: dashboard ${short(UI_BUILD_COMMIT)} · API ${api ? short(api.commit) : '…'}`}
      {differ ? ' — the dashboard and the API were built from different commits' : ''}
    </p>
  );
}
