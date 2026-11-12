import { PROVISIONAL_AFTER_DAYS, TENTATIVE_AFTER_DAYS } from '../domain/policy.ts';
import type { Ms } from '../domain/types.ts';

/**
 * How far past the orbital-elements epoch a predicted time lies.
 * These are wording tiers (an application policy), NOT accuracy figures:
 * no numerical error bars are claimed, because none are computed.
 */
export type HorizonTier = 'near-term' | 'tentative' | 'provisional';

export function horizonDays(targetMs: Ms, epochMs: Ms): number {
  return (targetMs - epochMs) / 86_400_000;
}

export function horizonTier(targetMs: Ms, epochMs: Ms): HorizonTier {
  const d = horizonDays(targetMs, epochMs);
  if (d > PROVISIONAL_AFTER_DAYS) return 'provisional';
  if (d > TENTATIVE_AFTER_DAYS) return 'tentative';
  return 'near-term';
}

export const TIER_ORDER: Record<HorizonTier, number> = { 'near-term': 0, tentative: 1, provisional: 2 };

export function worstTier(tiers: HorizonTier[]): HorizonTier {
  return tiers.reduce<HorizonTier>((a, b) => (TIER_ORDER[b] > TIER_ORDER[a] ? b : a), 'near-term');
}

export const TIER_TEXT: Record<HorizonTier, { label: string; note: string }> = {
  'near-term': {
    label: 'Near-term estimate',
    note: 'Based on orbital data from within the past week, so timing should hold up well. Re-check closer to the date.',
  },
  tentative: {
    label: 'Tentative estimate',
    note: 'Pass times this far from the orbital data can drift. Treat marginal passes as uncertain and re-check before the event.',
  },
  provisional: {
    label: 'Provisional estimate',
    note: 'This is far beyond the orbital data. Pass times can shift noticeably and some passes may appear or disappear when data is refreshed. Good for choosing a date, not for planning to the minute.',
  },
};
