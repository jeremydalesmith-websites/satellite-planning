import type { Ms } from '../domain/types.ts';
import type { PredictionMeta } from '../planner.ts';
import { fmtDateTime, tzAbbrev } from './format.ts';

interface Props {
  meta: PredictionMeta;
  tz: string;
  nowMs: Ms;
}

/** Three distinct timestamps: when data was downloaded, how old the orbital elements are, and when we calculated. */
export function DataFreshness({ meta, tz, nowMs }: Props) {
  const epochs = Object.values(meta.epochs);
  const oldest = epochs.length ? Math.min(...epochs) : null;
  const newest = epochs.length ? Math.max(...epochs) : null;
  const dl = Date.parse(meta.elementsDownloadedAt);
  const staleDays = (nowMs - dl) / 86_400_000;
  const z = (ms: Ms) => `${fmtDateTime(ms, tz)} ${tzAbbrev(ms, tz)}`;
  return (
    <dl className="fresh" aria-label="Data freshness">
      <div>
        <dt>Orbital data downloaded</dt>
        <dd>{z(dl)}</dd>
      </div>
      <div>
        <dt>Orbital elements dated (epoch)</dt>
        <dd>{oldest !== null && newest !== null ? (oldest === newest ? z(oldest) : `${z(oldest)} to ${z(newest)}`) : 'n/a'}</dd>
      </div>
      <div>
        <dt>Operating status downloaded</dt>
        <dd>{meta.statusDownloadedAt ? z(Date.parse(meta.statusDownloadedAt)) : 'unavailable: all repeaters unconfirmed'}</dd>
      </div>
      <div>
        <dt>Predictions calculated</dt>
        <dd>{z(meta.generatedAtMs)}</dd>
      </div>
      {staleDays > 3 && (
        <div className="warn-row">
          <dt>Note</dt>
          <dd>The downloaded data is {Math.round(staleDays)} days old. The site refreshes it automatically, but this copy may not have been updated yet.</dd>
        </div>
      )}
    </dl>
  );
}
