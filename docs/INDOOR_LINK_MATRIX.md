# Phase 6.3.7 — Indoor TX×RX Link Matrix

## Objective

Enable indoor all-pairs link solving by reusing the existing Link Analysis matrix UI, shared path/KPI models, PathSolver adapter, 3D ray overlay and experiment workflow. This phase does not enable indoor radio maps or trajectory/mobility yet.

## Implementation

### Backend

- Added `IndoorPathMatrixSolveRequest` with placed-device, uniqueness, scene-session, carrier and max-depth validation.
- Added `POST /api/scene/import/{session_id}/path-solve-matrix`.
- The endpoint validates that the indoor scene is both selected and active, applies the latest placed TX/RX snapshot once, then calls `solve_indoor_link_matrix()`.
- `solve_indoor_link_matrix()` calls the shared `_trace_paths()` once on the already-active Sionna scene. The native Sionna `Paths` tensors contain receiver×transmitter pair axes; the implementation maps those axes using the active Sionna registries and extracts every managed application TX×RX combination.
- Each pair uses the existing `_beamform()`, `_build_paths()` and `_channel_metrics()` helpers used by outdoor link solving. It returns its own `PropagationPath[]`, `ChannelMetrics` and execution metadata.
- Matrix-level execution metadata includes TX/RX counts, requested pair count, pairs with/without paths, solve duration, runtime version/variant and native tensor shapes.
- The active indoor scene geometry and radio materials are reused; only current device state is bound before solve.

### Frontend

- Enabled the existing `Solve All Pairs · Sionna RT` action in indoor mode.
- The app requires every TX and RX shown in the matrix to be placed in the currently active indoor scene; missing devices are named in the validation message.
- Indoor mode sends one complete device snapshot through `solveIndoorPathMatrix()` and populates the existing `MatrixCell` map from all returned pair results.
- Existing matrix display, click-to-focus behavior, selected-pair KPI/CIR panels, and 3D overlay are reused.
- Indoor matrix execution details are shown in Link Analysis.
- Added experiment replay through the dedicated indoor matrix endpoint.
- Updated stale Scene Import guidance: device binding is automatic; no separate synchronization action is required.

### Outdoor regression boundary

- Outdoor `POST /api/solve` is unchanged.
- Outdoor `handleSolveMatrix()` remains its existing serial per-pair loop.
- Outdoor scene construction, coordinates, path renderer, KPI/CIR and mobility/radio-map paths are unchanged.

## Why indoor uses one dispatch instead of serial requests

The outdoor UI historically issues one solver request per TX×RX pair. Indoor Sionna already has all placed transmitters and receivers registered in one active scene; a single native PathSolver result contains the complete receiver×transmitter tensor. Re-running PathSolver for every UI cell would repeat the full multi-device trace. This implementation extracts every pair from one native dispatch while preserving the same pair model and matrix behavior.

## Validation performed in this build

| Check | Result |
|---|---:|
| Full backend pytest | **275 passed, 12 subtests passed** |
| Indoor PathSolver focused tests | **12 passed** |
| Indoor link-matrix source contract | **12 assertions passed** |
| Indoor PathSolver integration contract | **30 assertions passed** |
| Indoor TX/RX runtime-binding contract | **29 assertions passed** |
| Indoor activation contract | **10 assertions passed** |
| Indoor placement integration contract | **PASS** |
| Shared path renderer contract | **8 assertions passed** |
| Scene Import contract | **12/12 passed** |
| Scene Manager contract | **11/11 passed** |
| Panel lifecycle contract | **PASS** |
| Antenna/RF integration contract | **PASS** |
| Python compileall | **PASS** |
| TypeScript/TSX syntax transpilation | **34/34 files passed** |
| Full `tsc --noEmit` | **Not verified** — `npm ci` timed out and left incomplete `@types` packages |
| Vite production build | **Not run** — frontend dependency install did not complete |
| FastAPI app import smoke test in this local container | **Not available** — Mitsuba is not installed in the local container; the Colab runtime provides the Sionna/Mitsuba stack |
| Actual Colab GPU matrix run | **Pending user acceptance** |

## Colab acceptance procedure

Use the existing `SionnaRTStudio_Colab_Launcher_ZIP_ONLY.ipynb` and upload this ZIP.

1. Run all notebook checks and require backend tests, all discovered `check:*` scripts, `tsc --noEmit` and Vite build to pass.
2. Import and activate the classroom scene using the known-good 28 GHz material mapping.
3. Place one TX and two RX devices in the same indoor scene.
4. Press `Solve All Indoor Pairs · Sionna RT`.
5. Require an HTTP 200 response with `totalPairs: 2` and a distinct result for `TX1→RX1` and `TX1→RX2`.
6. Confirm the matrix shows two independent RX Power values. Click each matrix cell and verify its KPIs, CIR/path list and 3D paths focus on that pair.
7. Repeat with at least two TX and two RX devices to validate the full cross-product.
8. Switch back to outdoor mode and confirm the existing outdoor all-pairs matrix is unchanged.

**Acceptance is not claimed until the real Colab run passes.** Local tests validate tensor extraction with a controlled two-RX fixture; they do not replace the user's Sionna RT 2.0.1 runtime test.

## Next indoor feature stages

1. **Indoor RadioMapSolver:** reuse the existing CoveragePanel, radio-map models, metrics and renderer. Adapt solver input to the already-active indoor scene and canonical local scene bounds; do not call the outdoor OSM scene builder or infer indoor coordinates from ENU/geography.
2. **Indoor trajectory/mobility:** reuse the existing TrajectoryPanel, mobility data models, PathSolver, KPI and handover logic where applicable. Add indoor scene-local waypoint creation/playback and adapt ray/trajectory overlays without changing outdoor GPS/ENU behavior.
3. Continue enabling later outdoor capabilities one at a time, with a clear indoor adapter and outdoor regression checks for each stage.
