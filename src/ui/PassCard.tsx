import { ACTIVITIES, describeBands } from '../catalog/catalog.ts';
import { duration } from '../domain/intervals.ts';
import type { Ms } from '../domain/types.ts';
import type { PassAssessment } from '../eligibility/assess.ts';
import { compass, fmtDateTime, fmtDuration, fmtTime, fmtTimeSec, tzAbbrev } from './format.ts';

export type PassRole = 'counted' | 'alternative' | 'conditional' | 'edge' | 'excluded';

const ROLE_LABEL: Record<PassRole, string> = {
  counted: 'Counts',
  alternative: 'Overlaps (not counted)',
  conditional: 'Conditional (not counted)',
  edge: 'Runs past event edge (not counted)',
  excluded: 'Not usable',
};

interface Props {
  pass: PassAssessment;
  role: PassRole;
  tz: string;
  /** Names of counted passes this one overlaps, for the "alternative" role. */
  overlapNames?: string[];
  window?: { start: Ms; end: Ms };
  statusDownloadedAt: string | null;
}

export function PassCard({ pass: p, role, tz, overlapNames, window, statusDownloadedAt }: Props) {
  const act = ACTIVITIES.find((a) => a.activityId === p.activityId)!;
  const eligMax = p.eligibleMaxElevationDeg;
  const differs = eligMax !== null && Math.abs(eligMax - p.fullMaxElevationDeg) >= 0.5;
  const above = p.aboveThreshold;
  const st = p.status;

  let why: string;
  switch (role) {
    case 'counted':
      why = 'Counts toward the event minimum.';
      break;
    case 'alternative':
      why = `Not counted: it overlaps ${overlapNames?.join(' and ') || 'another counted pass'}, and one station can only work one satellite at a time.`;
      break;
    case 'edge':
      why = window && p.operating
        ? `Not counted: the usable part (${fmtTimeSec(p.operating.start, tz)}–${fmtTimeSec(p.operating.end, tz)}) does not fit entirely inside the event.`
        : 'Not counted: its usable part does not fit entirely inside the event.';
      break;
    default:
      why = p.reasons[0] ?? '';
  }

  return (
    <article className={`pass ${role}`} aria-label={`${p.name} pass at ${fmtTime(p.peakMs, tz)}`}>
      <header>
        <h4>{p.name}</h4>
        <span className="badge">FM repeater</span>
        <span className="badge band" title={describeBands(act)}>{act.bandConfig}</span>
        <span className={`role ${role}`}>{ROLE_LABEL[role]}</span>
      </header>
      <p className="why">{why}</p>
      <p className="bands">{describeBands(act)}{act.uplink.ctcssHz ? ` · send a ${act.uplink.ctcssHz} Hz tone` : ''}</p>
      <dl>
        <div>
          <dt>Rises</dt>
          <dd>{fmtTime(p.riseMs, tz)} in the {compass(p.riseAzDeg)}</dd>
        </div>
        <div>
          <dt>Peaks</dt>
          <dd>{fmtTime(p.peakMs, tz)}</dd>
        </div>
        <div>
          <dt>Sets</dt>
          <dd>{fmtTime(p.setMs, tz)} in the {compass(p.setAzDeg)}</dd>
        </div>
        <div>
          <dt>Highest point</dt>
          <dd><strong>{p.fullMaxElevationDeg.toFixed(0)}°</strong> above the horizon</dd>
        </div>
        {differs && p.sunlightRestricted && (
          <div>
            <dt>Highest usable point</dt>
            <dd><strong>{eligMax!.toFixed(0)}°</strong> (the rest is in Earth’s shadow)</dd>
          </div>
        )}
        <div>
          <dt>Above {p.thresholdDeg}°</dt>
          <dd>{above ? `${fmtDuration(duration(above))} (${fmtTimeSec(above.start, tz)}–${fmtTimeSec(above.end, tz)})` : 'never'}</dd>
        </div>
        {p.sunlightRestricted && p.operating && (
          <div>
            <dt>Usable portion</dt>
            <dd>{fmtDuration(duration(p.operating))} ({fmtTimeSec(p.operating.start, tz)}–{fmtTimeSec(p.operating.end, tz)})</dd>
          </div>
        )}
      </dl>

      {p.sunlightRestricted ? (
        <p className={`sun ${p.sunlight}`}>
          <strong>Sunlight at the satellite:</strong>{' '}
          {p.sunlight === 'illuminated' && 'illuminated for the whole pass.'}
          {p.sunlight === 'partly-eclipsed' && `partly eclipsed (${fmtDuration(p.shadowMs)} in Earth’s shadow). Only the sunlit part is usable.`}
          {p.sunlight === 'eclipsed' && 'in Earth’s shadow for the whole pass, so this repeater should not be used.'}{' '}
          <span className="muted">This repeater is asked not to be used in eclipse. Local darkness doesn’t matter; sunlight at the satellite does.</span>
        </p>
      ) : null}

      <p className="status">
        <span className={`pill ${st.detail}`}>{st.label}</span> {st.explanation}
        {st.lastPositiveMs ? <> Last “heard” report {fmtDateTime(st.lastPositiveMs, tz)} {tzAbbrev(st.lastPositiveMs, tz)}.</> : null}
        {statusDownloadedAt ? <> <span className="muted">Status data downloaded {fmtDateTime(Date.parse(statusDownloadedAt), tz)}.</span></> : <span className="muted"> No status data loaded.</span>}
      </p>
      {act.restrictions.length > 0 && (
        <ul className="notes">
          {act.restrictions.map((r, i) => (
            <li key={i}>
              {r.text} <span className="muted">(AMSAT page dated {r.asOf}; manual catalog note, not live)</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
