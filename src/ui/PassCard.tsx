import { ACTIVITIES, compactBands, describeBands } from '../catalog/catalog.ts';
import { duration } from '../domain/intervals.ts';
import type { PassAssessment } from '../eligibility/assess.ts';
import { compass, fmtDateTime, fmtDuration, fmtEndSec, fmtSpan, fmtStartSec, fmtTime, fmtTimeSec, tzAbbrev } from './format.ts';

export type PassRole = 'counted' | 'alternative' | 'excluded';

const ROLE_LABEL: Record<Exclude<PassRole, 'counted'>, string> = {
  alternative: 'Overlaps (not counted)',
  excluded: 'Not counted',
};

interface Props {
  pass: PassAssessment;
  role: PassRole;
  tz: string;
  /** Names of counted passes this one overlaps, for the "alternative" role. */
  overlapNames?: string[];
  statusDownloadedAt: string | null;
}

export function PassCard({ pass: p, role, tz, overlapNames, statusDownloadedAt }: Props) {
  const act = ACTIVITIES.find((a) => a.activityId === p.activityId)!;
  const eligMax = p.eligibleMaxElevationDeg;
  const differs = eligMax !== null && Math.abs(eligMax - p.fullMaxElevationDeg) >= 0.5;
  const above = p.aboveThreshold;
  const st = p.status;
  const fullMs = p.setMs - p.riseMs;
  const showOperating = p.sunlightRestricted && p.verdict === 'eligible' && p.operatingMs < fullMs - 1000;

  let why: string | null = null;
  if (role === 'alternative') {
    why = `Overlaps ${overlapNames?.join(' and ') || 'another counted pass'}; one station works one satellite at a time.`;
  } else if (role === 'excluded') {
    why = p.reasons[0] ?? null;
  }

  return (
    <article className={`pass ${role}`} aria-label={`${p.name} pass at ${fmtTime(p.peakMs, tz)}`}>
      <header>
        <h4>{p.name}</h4>
        <span className="badge band" title={describeBands(act)}>{compactBands(act)}</span>
        {/* Any extra badges and the role label sit in the right column, so the band badge in the middle column is centered
            whether or not there is anything beside it (see .pass header in styles.css). */}
        <span className="pass-flags">
          {p.sunlightRestricted && (
            <span className="badge restrict" title="This repeater is asked not to be used in eclipse. Only sunlight at the satellite matters, not local darkness.">
              Sunlit only{p.sunlight === 'partly-eclipsed' ? ' · partly in shadow' : ''}
            </span>
          )}
          {act.interruptible && (
            <span className="badge restrict" title="Normally operating, but may be switched off by operations on its platform. See Details.">
              {act.interruptibleBadge ?? 'Subject to interruptions'}
            </span>
          )}
          {role !== 'counted' && <span className={`role ${role}`}>{ROLE_LABEL[role]}</span>}
        </span>
      </header>
      {why && <p className="why">{why}</p>}
      <dl className="key">
        <div className="aos-los">
          <dt>AOS–LOS</dt>
          <dd>{fmtStartSec(p.riseMs, tz)} – {fmtEndSec(p.setMs, tz)}</dd>
        </div>
        <div>
          <dt>Peak</dt>
          <dd>{fmtTime(p.peakMs, tz)}</dd>
        </div>
        <div>
          <dt>Max elevation</dt>
          <dd>
            {p.fullMaxElevationDeg.toFixed(0)}°{differs && p.sunlightRestricted ? <span className="muted"> ({eligMax!.toFixed(0)}° while sunlit)</span> : null}
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{fmtSpan(p.riseMs, p.setMs)}</dd>
        </div>
        {showOperating && (
          <div>
            <dt>Sunlit operating time</dt>
            <dd>{fmtDuration(p.operatingMs)}</dd>
          </div>
        )}
      </dl>

      <details className="more">
        <summary>Details</summary>
        <p className="bands">{describeBands(act)}{act.uplink.ctcssHz ? ` · send a ${act.uplink.ctcssHz} Hz tone` : ''}</p>
        <dl>
          <div>
            <dt>Rises / sets</dt>
            <dd>{compass(p.riseAzDeg)} → {compass(p.setAzDeg)}</dd>
          </div>
          <div>
            <dt>Time above {p.thresholdDeg}°</dt>
            <dd>{above ? `${fmtDuration(duration(above))} (${fmtTimeSec(above.start, tz)}–${fmtTimeSec(above.end, tz)})` : 'never'}</dd>
          </div>
          {p.sunlightRestricted && p.operatingIntervals.length > 0 && (
            <div>
              <dt>Sunlit operating interval{p.operatingIntervals.length > 1 ? 's' : ''}</dt>
              <dd>{p.operatingIntervals.map((o) => `${fmtStartSec(o.start, tz)}–${fmtEndSec(o.end, tz)}`).join(', ')} ({fmtDuration(p.operatingMs)} in total)</dd>
            </div>
          )}
        </dl>
        {p.sunlightRestricted && (
          <p className={`sun ${p.sunlight}`}>
            <strong>Sunlight at the satellite:</strong>{' '}
            {p.sunlight === 'illuminated' && 'illuminated for the whole pass.'}
            {p.sunlight === 'partly-eclipsed' && `partly eclipsed (${fmtDuration(p.shadowMs)} in Earth’s shadow, where operation is not permitted).`}
            {p.sunlight === 'eclipsed' && 'in Earth’s shadow for the whole pass, so this repeater should not be used.'}
          </p>
        )}
        <p className="status">
          <span className={`pill ${st.detail}`}>{st.label}</span> {st.explanation}
          {st.lastPositiveMs ? <> Last “heard” report {fmtDateTime(st.lastPositiveMs, tz)} {tzAbbrev(st.lastPositiveMs, tz)}.</> : null}{' '}
          <span className="muted">
            {statusDownloadedAt ? `Reports downloaded ${fmtDateTime(Date.parse(statusDownloadedAt), tz)}; checked against the current time, not re-downloaded.` : 'No status data loaded.'}
          </span>
        </p>
        {act.restrictions.length > 0 && (
          <ul className="notes">
            {act.restrictions.map((r, i) => (
              <li key={i}>
                {r.text}{' '}
                <span className="muted">
                  (Source: <a href={r.source.url}>{r.source.label}</a>
                  {r.moreSources?.map((s) => <span key={s.url}>; <a href={s.url}>{s.label}</a></span>)}; text as of {r.asOf}; manual catalog note, not live)
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}
