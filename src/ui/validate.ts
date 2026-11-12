/** Pure form validation: turns raw field text into PlanInputs or a list of useful messages. */
import { MAX_ELEVATION_INPUT_DEG, MAX_SEARCH_DAYS, MIN_ELEVATION_INPUT_DEG } from '../domain/policy.ts';
import { hasAnySelection, isValidTimeZone, rangeFromDates, validateAvailability } from '../availability/availability.ts';
import type { AvailabilitySettings } from '../availability/availability.ts';
import type { Ms } from '../domain/types.ts';
import type { PlanInputs } from '../planner.ts';

export interface FormFields {
  latText: string;
  lonText: string;
  timeZone: string;
  startDate: string;
  endDate: string;
  minElevationText: string;
  durationMin: number;
  minOpportunitiesText: string;
  availability: AvailabilitySettings;
}

export type FieldKey = keyof FormFields;
export interface FormErrors {
  field: FieldKey;
  message: string;
}

function parseNumber(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function validateForm(f: FormFields, nowMs: Ms): { inputs: PlanInputs | null; errors: FormErrors[] } {
  const errors: FormErrors[] = [];
  const add = (field: FieldKey, message: string) => errors.push({ field, message });

  const lat = parseNumber(f.latText);
  const lon = parseNumber(f.lonText);
  if (lat === null) add('latText', 'Enter your latitude in decimal degrees (for example 42.35). North is positive.');
  else if (lat < -90 || lat > 90) add('latText', 'Latitude must be between −90 and 90.');
  if (lon === null) add('lonText', 'Enter your longitude in decimal degrees (for example −71.06). West is negative.');
  else if (lon < -180 || lon > 180) add('lonText', 'Longitude must be between −180 and 180.');

  if (!isValidTimeZone(f.timeZone)) add('timeZone', 'Choose a valid time zone name, such as America/New_York.');

  const minEl = parseNumber(f.minElevationText);
  if (minEl === null) add('minElevationText', 'Enter the minimum peak elevation in degrees.');
  else if (minEl < MIN_ELEVATION_INPUT_DEG || minEl > MAX_ELEVATION_INPUT_DEG)
    add('minElevationText', `Use a minimum elevation between ${MIN_ELEVATION_INPUT_DEG}° and ${MAX_ELEVATION_INPUT_DEG}°.`);

  const minOpp = parseNumber(f.minOpportunitiesText);
  if (minOpp === null || !Number.isInteger(minOpp) || minOpp < 2 || minOpp > 10)
    add('minOpportunitiesText', 'Choose a whole number of opportunities from 2 to 10.');

  const availErrors = validateAvailability(f.availability);
  availErrors.forEach((m) => add('availability', m));
  if (availErrors.length === 0 && !hasAnySelection(f.availability))
    add('availability', 'Select when you are available. Nothing is assumed, so tick at least one day and time period.');

  let range = null;
  if (isValidTimeZone(f.timeZone)) {
    const r = rangeFromDates(f.startDate, f.endDate, f.timeZone, nowMs);
    r.errors.forEach((m) => add('endDate', m));
    range = r.range;
  }

  if (errors.length || lat === null || lon === null || minEl === null || minOpp === null || !range) {
    return { inputs: null, errors };
  }
  return {
    errors,
    inputs: {
      observer: { latDeg: lat, lonDeg: lon, heightKm: 0 },
      timeZone: f.timeZone,
      criteria: { minElevationDeg: minEl, maxSpanMin: f.durationMin, minOpportunities: minOpp },
      availability: f.availability,
      range,
    },
  };
}

export { MAX_SEARCH_DAYS };
