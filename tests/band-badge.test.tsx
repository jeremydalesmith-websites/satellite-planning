// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVITIES, compactBands } from '../src/catalog/catalog.ts';
import { PassCard } from '../src/ui/PassCard.tsx';
import { AO91, SO50, assessed } from './factory.ts';

afterEach(cleanup);

/**
 * Every pass card shows the uplink/downlink band badge (same oval, same place: the card header, right after the name).
 * SO-50 once appeared without it, so each catalog repeater is checked, not just a sample.
 */
const ISS = 25544;
const badge = (norad: number) => {
  const { container } = render(<PassCard pass={assessed({ norad, rise: 10, set: 20, maxEl: 60, thr: 40 }, 'recently-reported-active')} role="counted" tz="UTC" statusDownloadedAt={null} />);
  return { container, el: container.querySelector('header .badge.band') as HTMLElement | null };
};

describe('the band badge on a pass card', () => {
  it('SO-50 shows "↑ 2 m · ↓ 70 cm" (transmit 145.85 MHz, listen 436.795 MHz)', () => {
    expect(badge(SO50).el?.textContent).toBe('↑ 2 m · ↓ 70 cm');
  });
  it('ISS shows the same text; AO-91 (transmit 70 cm, listen 2 m) shows the reverse', () => {
    expect(badge(ISS).el?.textContent).toBe('↑ 2 m · ↓ 70 cm');
    cleanup();
    expect(badge(AO91).el?.textContent).toBe('↑ 70 cm · ↓ 2 m');
  });
  it('has the same oval styling and placement on SO-50, ISS and AO-91: a .badge.band right after the satellite name', () => {
    const shape = (norad: number) => {
      const { container, el } = badge(norad);
      const header = container.querySelector('header')!;
      const children = [...header.children].map((c) => c.tagName + '.' + c.className.split(' ').sort().join('.'));
      const r = { cls: el?.className, afterName: el?.previousElementSibling?.tagName, inHeader: el?.parentElement === header, firstTwo: children.slice(0, 2) };
      cleanup();
      return r;
    };
    const so = shape(SO50);
    expect(so.cls).toBe('badge band');
    expect(so.afterName).toBe('H4');
    expect(so.inHeader).toBe(true);
    for (const n of [ISS, AO91]) expect(shape(n)).toMatchObject({ cls: so.cls, afterName: so.afterName, inHeader: true });
  });
  it('is present, with a plain-language tooltip, for every catalog FM repeater', () => {
    for (const a of ACTIVITIES) {
      const { el } = badge(a.noradId);
      expect(el, a.name).toBeTruthy();
      expect(el!.textContent, a.name).toBe(compactBands(a));
      expect(el!.getAttribute('title'), a.name).toMatch(/Transmit on .* listen on /);
      cleanup();
    }
  });
});
