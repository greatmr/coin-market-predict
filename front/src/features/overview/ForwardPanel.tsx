// Overview: the forward test at a glance (results by stars and the last High check), linking to the
// full table.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { Lab } from '../../components/ui';
import { api } from '../../lib/api';
import { RUN } from '../../lib/constants';
import { fmtAgo, fmtDay, fmtInt } from '../../lib/format';
import { pathOf } from '../../lib/routes';
import { useApp } from '../../state/app';

import StarSummary from '../forward/StarSummary';
import { checksLine } from '../forward/UpdatePanel';
import type { ForwardSummary } from '../forward/types';

export default function ForwardPanel() {
  const { dataVersion } = useApp();
  const [s, setS] = useState<ForwardSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<ForwardSummary>('forward').then(
      (x) => {
        setS(x);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [dataVersion]);
  const last = s?.lastUpdate;
  const by = s?.counts.byStatus;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Forward test</h2>
        <span className="hint">
          {s && by
            ? `${fmtInt(s.counts.events)} events · ${fmtInt((by.OPEN ?? 0) + (by.TRACKING ?? 0) + (by.AWAITING_FINAL_DAY ?? 0))} active · ${fmtInt(by.FINAL)} final`
            : ''}
        </span>
        <Link className="link" to={pathOf('forward')}>
          Open the forward test
        </Link>
      </div>
      {failed ? (
        <div className="empty">The forward-test summary could not be loaded.</div>
      ) : !s ? null : (
        <>
          <div className="table-wrap">
            <StarSummary groups={s.cohort} compact />
          </div>
          <p className="muted small fwd-overview-foot">
            {last ? (
              <>
                {'Last High check '}
                <Lab map={RUN} k={last.status} />
                {` ${fmtAgo(last.startedAt)}, data through ${fmtDay(last.updateDate)} UTC. ${checksLine(last)}.`}
              </>
            ) : (
              'No High check yet: the first runs after the first UTC day closes.'
            )}{' '}
            Return is the peak return after identification (≥ while the window is open), not trading
            profit.
          </p>
        </>
      )}
    </div>
  );
}
