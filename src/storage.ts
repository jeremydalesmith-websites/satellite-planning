/** Browser localStorage wrappers. Every access is guarded: storage can be blocked, full, or empty. */
import { emptyAvailability, PERIOD_IDS } from './availability/availability.ts';
import type { AvailabilitySettings } from './availability/availability.ts';
import { isSavedEvent } from './saved/saved.ts';
import type { SavedEvent } from './saved/saved.ts';

const PREFS_KEY = 'satplanner.prefs.v1';
const EVENTS_KEY = 'satplanner.events.v1';

export interface Prefs {
  latText: string;
  lonText: string;
  timeZone: string;
  minElevationText: string;
  durationMin: number;
  minOpportunitiesText: string;
  availability: AvailabilitySettings;
  /**
   * The user's explicit satellite selection (NORAD IDs), stored exactly as chosen. Eligibility never
   * edits it: a satellite that is temporarily ineligible stays selected, and one the user unchecked
   * stays unchecked. Absent = the user has not chosen yet, so the defaults apply.
   */
  selectedIds?: number[];
}

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function validAvailability(a: unknown): a is AvailabilitySettings {
  const s = a as AvailabilitySettings | null;
  if (!s || !s.periods || !s.selected) return false;
  return PERIOD_IDS.every(
    (p) =>
      Array.isArray(s.selected[p]) &&
      s.selected[p].length === 7 &&
      typeof s.periods[p]?.startMin === 'number' &&
      typeof s.periods[p]?.endMin === 'number',
  );
}

export function loadPrefs(): Partial<Prefs> {
  const p = read(PREFS_KEY) as Partial<Prefs> | null;
  if (!p || typeof p !== 'object') return {};
  const out: Partial<Prefs> = {};
  if (typeof p.latText === 'string') out.latText = p.latText;
  if (typeof p.lonText === 'string') out.lonText = p.lonText;
  if (typeof p.timeZone === 'string') out.timeZone = p.timeZone;
  if (typeof p.minElevationText === 'string') out.minElevationText = p.minElevationText;
  if (typeof p.durationMin === 'number') out.durationMin = p.durationMin;
  if (typeof p.minOpportunitiesText === 'string') out.minOpportunitiesText = p.minOpportunitiesText;
  if (Array.isArray(p.selectedIds) && p.selectedIds.every((n) => Number.isInteger(n))) out.selectedIds = p.selectedIds;
  out.availability = validAvailability(p.availability) ? p.availability : emptyAvailability();
  return out;
}

export function savePrefs(p: Prefs): boolean {
  return write(PREFS_KEY, p);
}

export function loadEvents(): SavedEvent[] {
  const list = read(EVENTS_KEY);
  return Array.isArray(list) ? list.filter(isSavedEvent) : [];
}

export function saveEvents(events: SavedEvent[]): boolean {
  return write(EVENTS_KEY, events);
}
