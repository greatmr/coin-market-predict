// Data: the latest batch's data quality (quotes, LBank mapping, the LBank list, scan warnings, last
// export) and why coins are left out of the screen. Since D4 these counts are the only record of
// coins outside the review queue: no per-coin row is stored for them (any coin still opens on its
// coin page, evaluated on request).
import { HBars } from '../../components/charts';
import { SkeletonBlock } from '../../components/ui';
import { reasonText } from '../../lib/constants';
import { fmtInt } from '../../lib/format';
import { useApp } from '../../state/app';

import ForwardInsights from '../forward/ForwardInsights';
import Quality, { qualityMeta } from '../overview/Quality';
import type { ScanCountsDetail } from '../overview/types';

export default function Data() {
  const { overview: ov } = useApp();
  const sc = ov ? ov.scan : null;
  const c: ScanCountsDetail = (sc?.counts as ScanCountsDetail | undefined) ?? {};
  const reasons = Object.entries(c.reasons ?? {}).sort((x, y) => y[1] - x[1]);
  const outside = c.outsideUniverse ?? 0;
  const bars = [
    ...(outside
      ? [
          {
            label: 'Ranked above 1,200 or unranked (checked, not stored)',
            value: outside,
            tone: 'muted',
          },
        ]
      : []),
    ...reasons.map(([k, v]) => ({ label: reasonText(k), value: v, tone: 'rose' })),
  ];
  return (
    <>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Data quality</h2>
            <span className="hint">{qualityMeta(ov)}</span>
          </div>
          <div>{ov ? <Quality ov={ov} sc={sc} c={c} /> : <SkeletonBlock height={320} />}</div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Why coins are left out</h2>
            <span className="hint">
              {c.screened !== undefined
                ? `${fmtInt(c.screened)} coins ranked 1–1,200 screened; one can have several reasons`
                : 'a coin can have several reasons'}
            </span>
          </div>
          <div>
            {ov ? (
              <HBars items={bars} empty="No exclusions yet." />
            ) : (
              <SkeletonBlock height={320} />
            )}
          </div>
        </div>
      </div>
      <ForwardInsights />
    </>
  );
}
