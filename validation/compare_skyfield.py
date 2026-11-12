"""
Independent validation of this app's pass predictions against Skyfield.

Matching inputs: the SAME TLE lines, observer, time range and pass definition
(rise/set = elevation crosses 0 deg; peak = culmination). Skyfield uses the
separate `sgp4` Python package for propagation and its own TEME->ITRS handling.
Eclipse: Skyfield's EarthSatellite.at(t).is_sunlit(JPL DE421) vs this app's
satellite.js shadowFraction boundary.

Usage: python validation/compare_skyfield.py <elements.json> <ours.json> <de421.bsp>
"""
import json, sys
from datetime import datetime, timezone
import numpy as np
from skyfield.api import EarthSatellite, load, wgs84

elements = json.load(open(sys.argv[1]))
ours = json.load(open(sys.argv[2]))
from skyfield.jpllib import SpiceKernel
eph = SpiceKernel(sys.argv[3])
ts = load.timescale()
obs = wgs84.latlon(ours['lat'], ours['lon'], elevation_m=0)
t0 = ts.from_datetime(datetime.fromtimestamp(ours['start'] / 1000, tz=timezone.utc))
t1 = ts.from_datetime(datetime.fromtimestamp(ours['end'] / 1000, tz=timezone.utc))
ms = lambda t: t.utc_datetime().timestamp() * 1000

worst = {'rise': 0, 'set': 0, 'peak': 0, 'maxEl': 0}
rows, unmatched_ours, unmatched_ref = [], 0, 0
for s in elements['sets']:
    nid = str(s['noradId'])
    if nid not in ours['passes']:
        continue
    sat = EarthSatellite(s['line1'], s['line2'], s['name'], ts)
    times, events = sat.find_events(obs, t0, t1, altitude_degrees=0.0)
    ref = []
    cur = {}
    for t, e in zip(times, events):
        if e == 0: cur = {'rise': ms(t)}
        elif e == 1 and cur: cur['peak'] = ms(t)
        elif e == 2 and cur and 'peak' in cur:
            cur['set'] = ms(t); ref.append(cur); cur = {}
    for r in ref:
        diff = (sat - obs).at(ts.from_datetime(datetime.fromtimestamp(r['peak'] / 1000, tz=timezone.utc)))
        r['maxEl'] = diff.altaz()[0].degrees
    mine = [p for p in ours['passes'][nid] if p['maxEl'] >= 10]
    ref10 = [r for r in ref if r['maxEl'] >= 10]
    used = set()
    for r in ref10:
        m = min(mine, key=lambda p: abs(p['peak'] - r['peak']), default=None)
        if m is None or abs(m['peak'] - r['peak']) > 120_000:
            unmatched_ref += 1; continue
        used.add(id(m))
        d = dict(rise=(m['rise'] - r['rise']) / 1000, set=(m['set'] - r['set']) / 1000,
                 peak=(m['peak'] - r['peak']) / 1000, maxEl=m['maxEl'] - r['maxEl'])
        for k in ('rise', 'set', 'peak', 'maxEl'):
            worst[k] = max(worst[k], abs(d[k]))
        rows.append((s['name'], d))
    unmatched_ours += sum(1 for p in mine if id(p) not in used)

    # eclipse comparison: sample each of my sun segment boundaries and a grid inside passes
    mismatch = total = 0
    for p in ours['passes'][nid]:
        if p['maxEl'] < 10: continue
        for (a, b, lit) in p['sun']:
            for frac in (0.1, 0.5, 0.9):
                tt = a + (b - a) * frac
                t = ts.from_datetime(datetime.fromtimestamp(tt / 1000, tz=timezone.utc))
                total += 1
                mismatch += int(bool(sat.at(t).is_sunlit(eph)) != lit)
    print(f"{s['name']:<10} passes>=10deg: ours={len(mine)} skyfield={len(ref10)}  sunlight samples mismatching: {mismatch}/{total}")

n = len(rows)
print(f"\nMatched passes: {n}   unmatched (ours only): {unmatched_ours}   unmatched (skyfield only): {unmatched_ref}")
for k, label in (('rise', 'rise time (s)'), ('peak', 'peak time (s)'), ('set', 'set time (s)'), ('maxEl', 'max elevation (deg)')):
    vals = np.array([abs(r[1][k]) for r in rows])
    print(f"  {label:<22} median {np.median(vals):8.3f}   95th pct {np.percentile(vals, 95):8.3f}   max {vals.max():8.3f}")
