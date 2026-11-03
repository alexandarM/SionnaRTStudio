# Channel Analysis — On-demand Channel Analysis from Radio-Map Cells

## Workflow

1. Run a RadioMapSolver map as in Radio Coverage Analytics.
2. In **Channel Analysis · Channel Analysis**, choose a sector and a candidate criterion:
   - `Weakest SINR`
   - `Weakest RSS`
   - `Highest interference`
3. Load candidate locations. The sampling is deterministic and spreads selected
   points across the ranked cell list. Tick/untick candidates to choose up to
   12 locations, or add a specific map-cell index manually.
4. Choose which TX links to trace:
   - `Serving + dominant interferer` (default)
   - `Serving sector only`
   - `Selected sector only`
   - `All co-channel sectors`
5. Run Channel Analysis. The backend uses the scene context saved with the
   radio-map cache and performs one batched PathSolver dispatch for the
   Cartesian product of selected receiver locations and the required sectors.
   The response only returns links relevant to each selected cell.

The map cache saves the original transmitter models, buildings, materials,
carrier frequency, interaction switches, and max depth. The channel analysis
replays that original context rather than relying on possibly changed controls
in the browser. If the bounded cache has expired, recompute the radio map.

## Returned data

- Per-link LOS/NLOS, path count, total received power, strongest path, RMS delay
  spread and maximum absolute Doppler.
- Per-path geometry and interaction types, delay, received power, AoA and AoD
  (when finite Sionna `theta_t/phi_t/theta_r/phi_r` arrays are available).
- `K` factor computed as total zero-interaction LOS path power divided by the
  aggregate non-LOS path power. It is deliberately `null` for NLOS-only links
  and when no scattered component is present; the response includes the reason.
- Path-resolved CIR tap values and absolute propagation delays from the native
  `paths.cir(normalize_delays=False, out_type="numpy")` output.
- Native `paths.cfr()` values on a centered subcarrier grid. The displayed
  magnitude is the sum of physical receive-port powers after the same
  unit-norm uniform Tx precoder used by the link KPI path.
- A scalar CFR phase is returned only for one physical Rx port. For multi-port
  receive arrays, the aggregated magnitude has no unique scalar phase, so the
  phase field is `null` with an explanation.

## API

`GET /api/radiomap/{map_id}/sector/{tx_index}/samples`

Returns candidate cells from the existing cached radio-map data. Query
parameters: `criterion=weak_sinr|weak_rss|strong_interference`, `limit=1..60`.

`POST /api/radiomap/{map_id}/channel-analysis`

```json
{
  "cellIndices": [12, 88, 142],
  "txMode": "serving_and_interferer",
  "txIndex": null,
  "rxArraySize": [1, 1],
  "numSubcarriers": 64,
  "subcarrierSpacingHz": 30000,
  "pathsToReturn": 24
}
```

`txIndex` is required only for `txMode=selected`. Up to 12 unique cell indices
are accepted. The Cartesian product actually traced is capped at 96 Tx–Rx
pairs, and the estimated native CFR allocation is capped at 8,388,608 complex
samples before launching the solver. The frontend offers 64/128/256 CFR
subcarriers; the API accepts 8–256.

## Interpretation / limitations

- RadioMapSolver still does not provide a per-cell LOS flag; the LOS/NLOS label
  comes from the separate PathSolver run at the selected exact cell center.
- The PathSolver receiver is a physical planar array configured from the
  current Rx array controls. This may differ from the ideal isotropic receiver
  model used by RadioMapSolver.
- CIR taps are path-resolved native coefficients and delays, not a fabricated
  equal-delay-binned impulse response. The first native time snapshot is used.
- CFR magnitude aggregates receive-port powers. In MIMO mode no common scalar
  phase is claimed.
- Path angles are reported per path. No mean AoA/AoD is generated because an
  unweighted arithmetic mean of circular angles would be misleading.
- K-factor is a ray-tracing estimate over the paths returned with the selected
  solver switches and sampling seed; it is not a measured statistical channel
  fit.
- The default batch limit is conservative. Increase only after measuring GPU
  memory in the target Colab runtime.

## Verification

- Pure NumPy tests cover native six-axis CIR/CFR reduction, phase omission for
  multi-port Rx aggregation, request bounds and K-factor edge cases.
- Full backend unit tests are run with `python -m unittest discover -s
  backend/tests -v`.
- Live PathSolver execution still requires the user's Sionna RT 2.0.1 runtime
  and GPU (or a supported LLVM CPU variant). It is not represented as validated
  by the CPU-only unit tests.
