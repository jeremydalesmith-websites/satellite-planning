# Validation against an independent predictor

**Question answered:** does this app's pass and sunlight code agree with an
established, independently implemented predictor when given the *same* inputs?

**Question NOT answered:** how accurate are TLE-based predictions weeks into the
future in the real world? Both programs propagate the same orbital elements, so
they share that uncertainty. Nothing here measures it; see "Long-range limits"
in the README.

## Method

| | This app | Reference |
|---|---|---|
| Propagation | `satellite.js` 7.2 (SGP4) | `skyfield` 1.55 using the separate `sgp4` 2.27 package |
| Frames / look angles | `eciToEcf`, `ecfToLookAngles` | Skyfield's own TEME→ITRS and `altaz()` |
| Sunlight | `sunPos` + `shadowFraction` (conical umbra and penumbra) | `EarthSatellite.at(t).is_sunlit()` with JPL DE421 |
| Search | adaptive stepping + bisection / golden-section | `find_events(altitude_degrees=0)` |

Identical inputs: the same TLE lines (frozen real AMSAT download of 2026-11-12,
`tests/fixtures/`), the same observer (geodetic, height 0), the same time
range, and the same pass definition (rise/set = elevation crosses 0°, peak =
culmination). Passes with a maximum elevation under 10° are ignored.
Satellites: ISS, SO-50, CAS-3H (LILACSAT-2), AO-91, AO-123, TEVEL2-1.

Reproduce (needs Python 3):

```bash
python3 -m venv .venv && .venv/bin/pip install -r validation/requirements.txt
unzip -o -j "$(.venv/bin/pip download -q --no-deps -d /tmp/sf skyfield-data==7.0.0 >/dev/null && ls /tmp/sf/*.whl)" 'skyfield_data/data/de421.bsp' -d .venv
node validation/export-passes.ts tests/fixtures/elements-2026-11-12.json 42.0 -71.5 2026-11-12T15:15:00Z 5 /tmp/ours.json
.venv/bin/python -I validation/compare_skyfield.py tests/fixtures/elements-2026-11-12.json /tmp/ours.json .venv/de421.bsp
```

## Results (run 2026-11-12)

| Case | Matched passes | Rise Δ (median / max) | Peak Δ (median / max) | Set Δ (median / max) | Max-elevation Δ (median / max) |
|---|---|---|---|---|---|
| 42.0°N 71.5°W, 5 days from download | 112 | 0.02 s / 0.17 s | 0.05 s / 0.12 s | 0.02 s / 0.20 s | 0.001° / 0.007° |
| 33.87°S 151.21°E, 5 days | 92 | 0.02 s / 0.17 s | 0.06 s / 0.11 s | 0.02 s / 0.17 s | 0.001° / 0.005° |
| 42.0°N 71.5°W, 10 days starting 30 days after download | 223 | 0.02 s / 0.22 s | 0.06 s / 0.11 s | 0.02 s / 0.18 s | 0.001° / 0.005° |

**Adopted tolerances** (used to judge future regressions, not accuracy claims):
rise/set/peak within 0.5 s, maximum elevation within 0.02°. Observed worst
cases are about 2–4× inside these.

## Discrepancies, and why

1. **A pass in progress when the range starts** (e.g. TEVEL2-1 on 2026-11-12,
   rising 15:09 for a range starting 15:15; AO-91 at the Sydney start) is
   reported by this app with its true rise time. Skyfield's `find_events`
   lists only events inside the range, so it omits it. This is a definition
   difference, not a numerical one. It is intentional: an event window may
   begin while a pass is under way.
2. **Sunlight, 7 of ~1,000 samples disagree** (ISS 2/120, 1/78 and 4/231;
   SO-50 1/147). Every disagreement checked was within about 4 s of a
   lit/unlit boundary, inside a very short (≈35 s) grazing eclipse. The app
   deliberately treats any penumbra (Sun less than 99% visible) as *not
   sunlit*, which is conservative for repeaters that must not be used in
   eclipse. Skyfield's test is less strict. Only AO-91 is sunlight-restricted
   in the catalog, and it had no disagreements.
3. **No other unmatched passes** in 427 comparisons.

Automated regression tests in `tests/predict.test.ts` additionally compare the
adaptive search to a dense 1-second (peak refined to 10 ms) brute-force scan
using the same `satellite.js`, and `tests/planner.test.ts` compares sunlight
segments to a 2-second brute-force scan and the cluster finder to a
minute-by-minute reference.
