# SionnaRTStudio — Spatial Association & Geolocation Release Notes

**Release:** Spatial Association & Geolocation Analytics\
**Related modules:** Radio Coverage Analytics and Channel Analysis.\
**Scope:** additive UI, coordinate utilities, candidate selection and exports.

## Added

- Interactive 2D Cell-to-TX association map with RSS-serving, best-SINR,
  best-path-gain and dominant-interferer layers.
- Stable TX-ID categorical colours shared by 2D and 3D association views.
- Labelled TX markers and per-sector association counts in the 2D legend.
- Click-to-select cells, focus the 3D camera, and display a 3D locator pin/ring.
- WGS84 georeference snapshot stored with each radio-map result.
- WGS84 ellipsoid-based local ENU conversion replacing fixed degree-to-metre
  constants in the frontend coordinate helpers.
- WGS84 coordinates, Copy and Google Maps actions for selected cells and Channel Analysis candidate cards/results.
- Full geolocated radio-map CSV and geolocated weak-cell candidate CSV.
- Candidate association footprints: all map cells, RSS-serving footprint, or
  best-SINR footprint.
- Candidate ranking: true strict Top-K or spatially distributed sampling.
- Regression tests for strict Top-K and serving-footprint filtering.
- A frontend georeference check script and Spatial Association & Geolocation technical documentation.

## Preserved

- Radio Coverage Analytics RadioMapSolver outputs, KPI tables, sector analytics, CDF/histograms,
  interference matrix and leave-one-out/counterfactual analytics.
- Channel Analysis batched PathSolver, LOS/NLOS, path information, CIR/CFR, delay
  spread, K-factor, AoA/AoD and Doppler.
- Existing candidate endpoint behaviour for API callers that omit the new
  query parameters (`all` + `spatially_distributed`).

## Scientific/coordinate caveats

- The coordinate conversion is a local WGS84 tangent-plane ENU transform. It is
  intended for campus/local-area scenes; larger study areas should use a
  projected CRS workflow such as the appropriate UTM zone.
- WGS84 output is only reliable if the scene anchor actually corresponds to the
  real-world origin of the imported scene. Google Maps displays the simulated
  cell centre, not a surveyed ground-truth point.
- RSS-serving and best-SINR serving footprints are separate association
  definitions. Channel Analysis TX mode independently determines which sectors
  are actually traced.
- No new ray tracing is performed by the visualization/geolocation features.

## Validation status for this archive

- `python -m pytest backend/tests -q`: **138 passed**.
- `python -m unittest discover -s backend/tests -p 'test_*.py' -q`:
  **113 passed**.
- `python -m compileall -q backend scripts`: passed.
- `bash -n run.sh setup.sh scripts/runtime-env.sh`: passed.
- TypeScript/TSX transpile parse using TypeScript 5.8.3: **29 files, 0
  syntax diagnostics**.
- WGS84 ENU round-trip, axis direction/local scale and stable sector colour
  runtime checks: passed.
- Full `tsc --noEmit` and Vite production build: **not completed**. The
  dependency installation (`npm ci`) did not finish in the build environment,
  so this archive is not represented as having passed a full frontend typecheck
  or production build.
- The modified project was not run against a live Sionna RT GPU runtime in the
  build environment. The Channel Analysis Colab acceptance flow remains relevant; for
  this additive Spatial Association & Geolocation release, follow the short smoke test in
  `docs/SPATIAL_ASSOCIATION_AND_GEOLOCATION.md`.

These checks distinguish Python regression coverage and frontend syntax
transpilation from full frontend compilation and live Sionna runtime execution.

## Post-release fix — persistent radio-map 3D layer

The Three.js radio-map layer is now retained when switching between the Studio
modes `Radio Coverage`, `Link Analysis`, and `Trajectory`. Leaving Radio
Coverage hides the existing heatmap group instead of clearing and disposing
its instanced mesh. Returning to Radio Coverage restores the same 3D layer,
including its active association/metric rendering and focused-cell marker,
without rerunning RadioMapSolver or rebuilding the mesh when the map and display
settings have not changed.

The layer is still disposed when `radioMap` is genuinely cleared, and is rebuilt
when the result or relevant display settings change. See
`docs/RADIO_MAP_VIEW_PERSISTENCE.md` for the manual acceptance procedure.
