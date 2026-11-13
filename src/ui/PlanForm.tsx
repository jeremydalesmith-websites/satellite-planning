import { useEffect, useMemo, useState } from 'react';
import { addDays, localDate } from '../availability/availability.ts';
import { EVENT_DURATIONS_MIN, MAX_SEARCH_DAYS, DEFAULT_MIN_ELEVATION_DEG, DEFAULT_MIN_OPPORTUNITIES, DEFAULT_SEARCH_DAYS } from '../domain/policy.ts';
import { loadPrefs, savePrefs } from '../storage.ts';
import { DEFAULT_SELECTED_NORAD_IDS } from '../eligibility/eligibility.ts';
import type { SatelliteEligibility } from '../eligibility/eligibility.ts';
import { AvailabilityGrid } from './AvailabilityGrid.tsx';
import { SatellitePicker } from './SatellitePicker.tsx';
import { validateForm } from './validate.ts';
import type { FieldKey, FormErrors, FormFields } from './validate.ts';
import type { PlanInputs } from '../planner.ts';
import { emptyAvailability } from '../availability/availability.ts';

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zoneList(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

function initialFields(): FormFields {
  const prefs = loadPrefs();
  const tz = prefs.timeZone || browserTimeZone();
  const today = localDate(Date.now(), tz);
  return {
    latText: prefs.latText ?? '',
    lonText: prefs.lonText ?? '',
    timeZone: tz,
    startDate: today,
    endDate: addDays(today, DEFAULT_SEARCH_DAYS - 1, tz),
    minElevationText: prefs.minElevationText ?? String(DEFAULT_MIN_ELEVATION_DEG),
    durationMin: prefs.durationMin ?? 150,
    minOpportunitiesText: prefs.minOpportunitiesText ?? String(DEFAULT_MIN_OPPORTUNITIES),
    availability: prefs.availability ?? emptyAvailability(),
  };
}

interface Props {
  busy: boolean;
  onSearch: (inputs: PlanInputs) => void;
  /** Eligibility of each catalog repeater (evaluated by the app); null/undefined = not loaded. */
  eligibility?: SatelliteEligibility[] | null;
}

export function PlanForm({ busy, onSearch, eligibility = null }: Props) {
  const [f, setF] = useState<FormFields>(initialFields);
  // The user's explicit choice, stored as chosen. null = never chosen, so the defaults apply.
  const [chosen, setChosen] = useState<number[] | null>(() => loadPrefs().selectedIds ?? null);
  const selected: readonly number[] = chosen ?? DEFAULT_SELECTED_NORAD_IDS;
  const toggle = (id: number) => setChosen(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const [submitted, setSubmitted] = useState(false);
  const singlePass = Number(f.minOpportunitiesText.trim()) === 1; // minimum passes = 1: single-pass mode
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  // The time zone is a compact line until the user asks to change it (or it is invalid, so the error has a field).
  const [tzOpen, setTzOpen] = useState(false);
  const zones = useMemo(zoneList, []);

  // Persist preferences locally (location included: it never leaves this browser).
  useEffect(() => {
    savePrefs({
      latText: f.latText,
      lonText: f.lonText,
      timeZone: f.timeZone,
      minElevationText: f.minElevationText,
      durationMin: f.durationMin,
      minOpportunitiesText: f.minOpportunitiesText,
      availability: f.availability,
      ...(chosen ? { selectedIds: chosen } : {}),
    });
  }, [f.latText, f.lonText, f.timeZone, f.minElevationText, f.durationMin, f.minOpportunitiesText, f.availability, chosen]);

  const set = <K extends keyof FormFields>(k: K, v: FormFields[K]) => setF((p) => ({ ...p, [k]: v }));
  // Messages are validated against the CURRENT time. `clock` is bumped when Search is pressed, so a range that has
  // passed since the form was last edited (an idle tab) is reported at that moment instead of silently doing nothing.
  const [clock, setClock] = useState(0);
  const { errors } = useMemo(() => validateForm(f, Date.now()), [f, clock]);
  const err = (k: FieldKey): FormErrors | undefined => (submitted ? errors.find((e) => e.field === k) : undefined);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    // Validate against the time of THIS click: the memoised result may be hours old if the tab sat idle.
    const fresh = validateForm(f, Date.now()).inputs;
    setClock((c) => c + 1); // re-validate for display with the same fresh time
    if (fresh) onSearch({ ...fresh, selectedNoradIds: selected });
  };

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setGeoMsg('This browser cannot provide a location. Enter the coordinates by hand.');
      return;
    }
    setGeoMsg('Asking your browser for your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setF((p) => ({ ...p, latText: pos.coords.latitude.toFixed(4), lonText: pos.coords.longitude.toFixed(4) }));
        setGeoMsg('Location filled in from your device (rounded to about 10 m). It is stored only in this browser.');
      },
      (e) => setGeoMsg(`Could not get your location (${e.message || 'permission denied'}). Enter the coordinates by hand.`),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
    );
  };

  const setRange = (days: number) => set('endDate', addDays(f.startDate, days - 1, f.timeZone));
  const errList = submitted ? errors : [];

  return (
    <form className="card plan-form" onSubmit={submit} noValidate aria-label="Plan an event">

      {errList.length > 0 && (
        <div className="error-summary" role="alert" id="error-summary">
          <strong>Please fix {errList.length === 1 ? 'this' : 'these'} before searching:</strong>
          <ul>
            {errList.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset>
        <legend>Location</legend>
        <div className="loc-row">
          <label className="coord">
            Latitude (°)
            <input inputMode="decimal" value={f.latText} onChange={(e) => set('latText', e.target.value)} placeholder="e.g. 42.35" aria-invalid={!!err('latText')} aria-describedby="lat-err" autoComplete="off" />
          </label>
          <label className="coord">
            Longitude (°)
            <input inputMode="decimal" value={f.lonText} onChange={(e) => set('lonText', e.target.value)} placeholder="e.g. -71.06" aria-invalid={!!err('lonText')} aria-describedby="lon-err" autoComplete="off" />
          </label>
          <button type="button" className="secondary" onClick={locate}>Use my location</button>
        </div>
        <span className="field-err" id="lat-err">{err('latText')?.message}</span>
        <span className="field-err" id="lon-err">{err('lonText')?.message}</span>
        {geoMsg && <p className="hint small" role="status">{geoMsg}</p>}
      </fieldset>

      <fieldset>
        <legend>Dates</legend>
        <div className="date-row">
          <div className="date-range">
            <input type="date" aria-label="Start date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} aria-invalid={!!err('endDate')} aria-describedby="end-err" />
            <span className="dash" aria-hidden="true">–</span>
            <input type="date" aria-label="End date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} aria-invalid={!!err('endDate')} aria-describedby="end-err" />
          </div>
          <div className="chips" role="group" aria-label="Quick date range">
            {[14, 28, MAX_SEARCH_DAYS].map((n) => (
              <button type="button" className="chip" key={n} onClick={() => setRange(n)}>{n} days</button>
            ))}
          </div>
        </div>
        <span className="field-err" id="end-err">{err('endDate')?.message}</span>
        {/* Time zone: the browser's zone unless the user saved another. Not derived from the coordinates. */}
        <p className="tz-line">
          Timezone: <strong>{f.timeZone || 'unset'}</strong> ·{' '}
          <button type="button" className="link" aria-expanded={tzOpen || !!err('timeZone')} aria-controls="tz-field" onClick={() => setTzOpen((o) => !o)}>
            Change
          </button>
        </p>
        {(tzOpen || !!err('timeZone')) && (
          <div id="tz-field">
            <label>
              Time zone
              <input list="zones" value={f.timeZone} onChange={(e) => set('timeZone', e.target.value)} aria-invalid={!!err('timeZone')} aria-describedby="tz-err" autoComplete="off" spellCheck={false} />
              <datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
              <span className="field-err" id="tz-err">{err('timeZone')?.message}</span>
            </label>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Requirements</legend>
        <div className="row two">
          <label>
            Minimum peak elevation (°)
            <input inputMode="numeric" value={f.minElevationText} onChange={(e) => set('minElevationText', e.target.value)} aria-invalid={!!err('minElevationText')} aria-describedby="el-err" />
            <span className="field-err" id="el-err">{err('minElevationText')?.message}</span>
          </label>
          <label>
            Minimum passes
            <input inputMode="numeric" value={f.minOpportunitiesText} onChange={(e) => set('minOpportunitiesText', e.target.value)} aria-invalid={!!err('minOpportunitiesText')} aria-describedby="opp-err" />
            <span className="field-err" id="opp-err">{err('minOpportunitiesText')?.message}</span>
          </label>
        </div>
        {/* With 1 minimum pass every pass is its own result, so there is no cluster for a span to constrain. */}
        {!singlePass && (
          <>
            <span className="seg-label" id="span-label">Maximum span</span>
            <div className="seg" role="radiogroup" aria-labelledby="span-label">
              {EVENT_DURATIONS_MIN.map((m) => (
                <label key={m} className={f.durationMin === m ? 'on' : ''}>
                  <input type="radio" name="dur" checked={f.durationMin === m} onChange={() => set('durationMin', m)} />
                  {m / 60} hours
                </label>
              ))}
            </div>
          </>
        )}
      </fieldset>

      <SatellitePicker eligibility={eligibility} selected={selected} onToggle={toggle} />

      <AvailabilityGrid
        value={f.availability}
        onChange={(v) => set('availability', v)}
        timeZone={f.timeZone}
        invalid={!!err('availability')}
        describedBy="avail-err"
      />
      <span className="field-err" id="avail-err">{err('availability')?.message}</span>

      <button type="submit" className="primary" disabled={busy}>{busy ? 'Searching…' : 'Find event windows'}</button>
    </form>
  );
}
