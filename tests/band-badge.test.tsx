// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
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

/**
 * ALIGNMENT. SO-50's badge once sat at the right while ISS and AO-91 looked centered. Cause: the event heading's rule
 * (`.event header { justify-content: space-between }`) also matched every pass card header, so one badge was centered only by
 * accident (a third item pushed it to the middle) and a card with two items put it at the far right. The fix is one shared
 * layout: name | band badge | extra badges, the band badge always the centered middle column. jsdom cannot measure layout, so
 * the structure and the stylesheet rules are checked here, and the measured offsets (0 px at 1100, 390 and 320 px, with and
 * without an extra badge) were verified in a real browser.
 */
describe('band badge alignment comes from the shared layout', () => {
  const css = readFileSync('src/ui/styles.css', 'utf8');
  const header = (norad: number) => badge(norad).container.querySelector('article.pass > header') as HTMLElement;

  it('every card has the same header structure: name, then the band badge, then a flags container', () => {
    for (const norad of [SO50, ISS, AO91]) {
      const h = header(norad);
      expect([...h.children].map((c) => c.tagName + '.' + c.className)).toEqual(['H4.', 'SPAN.badge band', 'SPAN.pass-flags']);
      cleanup();
    }
  });
  it('extra badges and the role label live in the flags container, never beside the band badge', () => {
    const iss = header(ISS);
    expect(iss.querySelector('.pass-flags .badge.restrict')?.textContent).toMatch(/ISS operations/);
    expect(iss.querySelector(':scope > .badge.restrict')).toBeNull();
    cleanup();
    expect(header(SO50).querySelector('.pass-flags')?.children.length).toBe(0); // SO-50 simply has nothing there
  });
  it('the stylesheet centers the band badge for all cards (no per-satellite rule) and the event heading rule no longer leaks into pass cards', () => {
    expect(css).toMatch(/\.pass header \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.pass header > \.badge\.band \{[^}]*justify-self: center/);
    expect(css).toMatch(/\.event > header \{[^}]*justify-content: space-between/);
    expect(css).not.toMatch(/\.event header \{/);
    expect(css.slice(css.indexOf('.pass header'), css.indexOf('.role {'))).not.toMatch(/27607|SO-?50|iss|ao-?91/i); // no satellite-specific rule
  });
  it('on narrow screens the badge keeps its own centered row', () => {
    expect(css).toMatch(/@media \(max-width: 520px\) \{[^}]*\.pass header \{[^}]*\}[^}]*\.pass header > \.badge\.band \{[^}]*grid-column: 1 \/ -1/s);
  });
});
