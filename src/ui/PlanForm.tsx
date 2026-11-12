import { useEffect, useMemo, useState } from 'react';
import { addDays, localDate } from '../availability/availability.ts';
import { EVENT_DURATIONS_MIN, MAX_SEARCH_DAYS, DEFAULT_MIN_ELEVATION_DEG, DEFAULT_MIN_OPPORTUNITIES, DEFAULT_SEARCH_DAYS } from '../domain/policy.ts';
import { loadPrefs, savePrefs } from '../storage.ts';
import { AvailabilityGrid } from './AvailabilityGrid.tsx';
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
}

export function PlanForm({ busy, onSearch }: Props) {
  const [f, setF] = useState<FormFields>(initialFields);
  const [submitted, setSubmitted] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
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
    });
  }, [f.latText, f.lonText, f.timeZone, f.minElevationText, f.durationMin, f.minOpportunitiesText, f.availability]);

  const set = <K extends keyof FormFields>(k: K, v: FormFields[K]) => setF((p) => ({ ...p, [k]: v }));
  const { inputs, errors } = useMemo(() => validateForm(f, Date.now()), [f]);
  const err = (k: FieldKey): FormErrors | undefined => (submitted ? errors.find((e) => e.field === k) : undefined);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (inputs) onSearch(inputs);
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
    <form className="card plan-form" onSubmit={submit} noValidate aria-labelledby="plan-title">
      <h2 id="plan-title">Find available event windows with multiple FM satellite passes.</h2>
      <p className="hint">
        Planning only: this finds clusters of usable passes inside the times you are free. It does not track satellites live.
      </p>

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
        <legend>Where will the event be?</legend>
        <div className="row two">
          <label>
            Latitude (°)
            <input inputMode="decimal" value={f.latText} onChange={(e) => set('latText', e.target.value)} placeholder="e.g. 42.35" aria-invalid={!!err('latText')} aria-describedby="lat-err" autoComplete="off" />
            <span className="field-err" id="lat-err">{err('latText')?.message}</span>
          </label>
          <label>
            Longitude (°)
            <input inputMode="decimal" value={f.lonText} onChange={(e) => set('lonText', e.target.value)} placeholder="e.g. -71.06" aria-invalid={!!err('lonText')} aria-describedby="lon-err" autoComplete="off" />
            <span className="field-err" id="lon-err">{err('lonText')?.message}</span>
          </label>
        </div>
        <button type="button" className="secondary" onClick={locate}>Use my current location</button>
        <p className="hint small" role="status">{geoMsg ?? 'Your location is never guessed. It is used only for the calculation and saved in this browser, not sent anywhere.'}</p>
      </fieldset>

      <fieldset>
        <legend>Dates and time zone</legend>
        <label>
          Time zone
          <input list="zones" value={f.timeZone} onChange={(e) => set('timeZone', e.target.value)} aria-invalid={!!err('timeZone')} aria-describedby="tz-err" autoComplete="off" spellCheck={false} />
          <datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          <span className="field-err" id="tz-err">{err('timeZone')?.message}</span>
        </label>
        <div className="row two">
          <label>
            Search from
            <input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </label>
          <label>
            through
            <input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} aria-invalid={!!err('endDate')} aria-describedby="end-err" />
          </label>
        </div>
        <span className="field-err" id="end-err">{err('endDate')?.message}</span>
        <div className="chips" role="group" aria-label="Quick date range">
          {[14, 28, MAX_SEARCH_DAYS].map((n) => (
            <button type="button" className="chip" key={n} onClick={() => setRange(n)}>{n} days</button>
          ))}
        </div>
        <p className="hint small">Up to {MAX_SEARCH_DAYS} days. Dates more than a week or so beyond the orbital data are shown as tentative or provisional.</p>
      </fieldset>

      <fieldset>
        <legend>What counts as a good pass?</legend>
        <div className="row two">
          <label>
            Minimum peak elevation (°)
            <input inputMode="numeric" value={f.minElevationText} onChange={(e) => set('minElevationText', e.target.value)} aria-invalid={!!err('minElevationText')} aria-describedby="el-err" />
            <span className="field-err" id="el-err">{err('minElevationText')?.message}</span>
          </label>
          <label>
            Opportunities needed
            <input inputMode="numeric" value={f.minOpportunitiesText} onChange={(e) => set('minOpportunitiesText', e.target.value)} aria-invalid={!!err('minOpportunitiesText')} aria-describedby="opp-err" />
            <span className="field-err" id="opp-err">{err('minOpportunitiesText')?.message}</span>
          </label>
        </div>
        <p className="hint small">Higher elevation means a stronger, longer pass. A pass counts only when it reaches this elevation at a time the repeater can be used.</p>
        <div className="seg" role="radiogroup" aria-label="Event duration">
          {EVENT_DURATIONS_MIN.map((m) => (
            <label key={m} className={f.durationMin === m ? 'on' : ''}>
              <input type="radio" name="dur" checked={f.durationMin === m} onChange={() => set('durationMin', m)} />
              {m / 60} hours
            </label>
          ))}
        </div>
      </fieldset>

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
