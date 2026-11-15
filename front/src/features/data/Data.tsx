// Data: the latest batch's data quality (quotes, LBank mapping, the LBank list, scan warnings, last
// export) and why coins are left out of the screen. Moved here from the overview.
import { HBars } from '../../components/charts';
import { reasonText } from '../../lib/constants';
import { useApp } from '../../state/app';

import Quality, { qualityMeta } from '../overview/Quality';
import type { ScanCountsDetail } from '../overview/types';

export default function Data() {
  const { overview: ov } = useApp();
  const sc = ov ? ov.scan : null;
  const c: ScanCountsDetail = (sc?.counts as ScanCountsDetail | undefined) ?? {};
  const reasons = Object.entries(c.reasons ?? {}).sort((x, y) => y[1] - x[1]);
  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-head">
          <h2>Data quality</h2>
          <span className="hint">{qualityMeta(ov)}</span>
        </div>
        <div>{ov ? <Quality ov={ov} sc={sc} c={c} /> : null}</div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Why coins are left out</h2>
          <span className="hint">a coin can have several reasons</span>
        </div>
        <div>
          {ov ? (
            <HBars
              items={reasons.map(([k, v]) => ({ label: reasonText(k), value: v, tone: 'rose' }))}
              empty="No exclusions yet."
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
