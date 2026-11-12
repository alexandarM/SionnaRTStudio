# Phase 6.3 — Indoor Sionna RT PathSolver

**Scope:** execute one selected indoor TX→RX ray-tracing link on the already activated Sionna RT scene. This phase connects the existing Link Analysis workflow to the real indoor `PathSolver`. It does not add indoor radio maps, trajectories, or all-pairs solving.

## User workflow

1. Import and select the classroom scene in Persistent Scene Manager.
2. Activate the Sionna RT scene and map every referenced source material to a valid installed ITU material (Phase 6.1).
3. Place the TX and RX in the shared viewport (Phase 4).
4. Configure carrier frequency, TX/RX array dimensions, patterns, polarizations, TX power, and local TX steering in the existing RF controls (Phase 5).
5. Select the intended TX and RX in Link Analysis, choose PathSolver interaction flags, maximum depth and samples-per-source, then press **Solve Link · Sionna RT**. The app sends the current placed TX/RX snapshot and RF settings with the request; the backend binds them to the active scene automatically before tracing.
6. Inspect returned rays in the existing 3D path overlay and the received-power, delay-spread, LOS/NLOS and path-count KPIs. The Link panel reports solver execution status and runtime diagnostics.

Indoor **Solve All Pairs** remains deliberately disabled in this phase. It will be enabled only after the selected-link flow is validated in the actual classroom runtime.

## Runtime architecture

- The dedicated endpoint is `POST /api/scene/import/{session_id}/path-solve`.
- The endpoint is separate from outdoor `POST /api/solve` and is guarded by the shared solve lock.
- It requires that the requested scene is both selected in the Scene Manager and currently active in the indoor Sionna runtime.
- It accepts one selected TX ID, one selected RX ID, the current placed TX/RX snapshots, carrier frequency, maximum depth and the existing `SolverOptions` object.
- The backend validates the token, device membership, Sionna registry names, canonical runtime positions, current scene frequency and scene-level TX/RX array dimensions, antenna pattern and polarization before dispatch.
- The backend invokes the existing `_trace_paths()` adapter with the already-active indoor Sionna scene. It does not call `load_scene()`, rebuild XML/PLY geometry, or invoke outdoor `build_scene()`.
- The current PathSolver invocation uses `synthetic_array=True`. Sionna traces geometry from the TX/RX device centre positions; the returned channel coefficients retain the physical TX/RX antenna-port dimensions. The adapter therefore reduces only geometry tensors' singleton synthetic-array axes and keeps antenna axes in the complex coefficients for Tx precoding and Rx-port power aggregation.
- For scenes with more than one synchronized device, Sionna computes its available transmitter/receiver combinations and the backend extracts the selected RX/TX tensor slice using the actual scene registry order. The initial Colab acceptance should use one TX and one RX to keep the first runtime test unambiguous and inexpensive.
- Sionna geometry and bounce points remain in canonical indoor local coordinates (right-handed, +Z up, +X forward, metres). These map directly to the app's indoor scene-local path point model.
- Native `Paths` tensors are converted to the existing `PropagationPath` and `ChannelMetrics` response models. Path power includes the Sionna complex channel coefficients, unit-norm TX precoding and physical RX ports; no separate synthetic “antenna count gain” is added.
- A completed solver call with zero valid paths is returned as `completed_no_paths`, distinct from a solver error. No fake LOS path or fallback result is fabricated.
- Inactive scene, wrong selection, missing TX/RX, stale token, registry mismatch, frequency/array mismatch and solver errors fail closed with explicit HTTP errors. There is no outdoor fallback.

## Frontend integration

- Existing Link Analysis `Solve Link` dispatches to the indoor endpoint only when an indoor scene is active. Outdoor requests continue using the pre-existing `/api/solve` function and request body.
- Before sending, the frontend verifies both selected devices and the full submitted placed-device set have canonical poses associated with the active indoor scene.
- Under the shared backend solve lock, the endpoint automatically registers the submitted device snapshot, arrays, carrier frequency and RF settings, then invokes PathSolver with the resulting backend-generated token. Device state and solve therefore cannot race with a separate browser synchronization call.
- Changes to device placement, orientation, array/RF configuration or carrier frequency are picked up from the next Solve Link request. No manual re-synchronization is required.
- The UI displays the PathSolver completion status or the explicit no-valid-paths result.
- Indoor all-pairs matrix solving is disabled in this phase; the existing outdoor matrix implementation is unchanged.

## Diagnostics returned

The `execution` response includes:

- completion status (`completed` or `completed_no_paths`), solver name, Sionna RT version and Mitsuba variant;
- active scene session, selected application TX/RX IDs and runtime names;
- carrier frequency, maximum depth, samples per source and random seed;
- valid path count, candidate path slots, and returned path count;
- active registered geometry-object and radio-material counts;
- native and normalized tensor dimensions for validity, delays, Doppler, interaction points, vertices and channel coefficients;
- maximum Doppler magnitude and elapsed solve/processing time;
- the synchronization token used for the run.

The diagnostics are also stored with the experiment record so the solve can be audited and replayed as a request. The replay record uses the dedicated indoor endpoint and does not silently replay through the outdoor solver.

## Local validation

| Check | Result |
|---|---:|
| Full backend pytest | **265 passed, 12 subtests passed** |
| Targeted indoor PathSolver tests | **6 passed** |
| Targeted indoor PathSolver + device runtime tests | **19 passed** |
| New indoor PathSolver source-contract checks | **24 passed** |
| Scene Import contract | **12 passed** |
| Scene Manager contract | **11 passed** |
| Indoor placement contract | **PASS** |
| Antenna/RF contract | **PASS** |
| Indoor activation contract | **10 passed** |
| Indoor TX/RX runtime-sync contract | **19 passed** |
| Panel lifecycle checks | **PASS** |
| Python compileall | **PASS** |
| TypeScript/TSX syntax transpilation | **34 files, PASS** |
| Full TypeScript type-check | **Not verified locally**; local `node_modules` is incomplete and `tsc --noEmit` reports missing type-definition packages |
| Vite production build | **Not verified locally**; dependency installation did not complete |
| Actual Sionna RT 2.0.1 PathSolver in Colab | **Pending user acceptance**; mocked PathSolver tensors are unit-test fixtures, not a GPU runtime result |

The existing ZIP-only Colab notebook discovers every `check:*` entry from `package.json`, so the new `check:indoor-path-solver` runs automatically without creating another notebook.

## Colab acceptance checklist

Use the existing `SionnaRTStudio_Colab_Launcher_ZIP_ONLY.ipynb`. Do not clone GitHub and do not create a new notebook.

1. Upload `SionnaRTStudio-1.0.0-phase6-3-indoor-path-solver.zip`.
2. Run the notebook from the top. Require dependency installation, backend pytest, every automatically discovered `check:*` script (including `check:indoor-path-solver`), full TypeScript type-check and Vite production build to pass.
3. Import/select the existing classroom `exported.zip` and activate it at **28 GHz** using the same known-good material mappings from Phase 6.1.
4. Start with exactly one TX and one RX. Confirm both are placed inside the active classroom and associated with the same Scene Manager session.
5. Use compatible scene-level arrays. Start with TX 1×1 / RX 1×1 for the cleanest baseline, or reuse the previously checked TX 4×2 / RX 1×1 setup.
6. In Link Analysis select that TX and RX. For a first test use `maxDepth=1` or `2`, `pathSamplesPerSource=100000`, keep LOS and specular reflection enabled, and initially leave optional diffraction/diffuse interactions disabled.
8. Press **Solve Link · Sionna RT**. Require an HTTP 200 response whose diagnostics identify Sionna RT 2.0.1, the active Mitsuba variant, the selected device IDs, 28 GHz, and a completed PathSolver dispatch. Confirm the reported native tensor shapes and registered object/material counts are present.
9. If `status=completed_no_paths`, capture the complete diagnostics. Confirm the TX/RX positions lie inside the canonical room bounds, check the mounted boresight and steering, inspect mapped materials and interaction flags, then retry a simple LOS case. Zero paths is a completed solver execution, not evidence of a solver crash and not itself a valid propagation path.
10. If paths are returned, confirm rays appear between the selected TX and RX in the viewport and that path count, LOS/NLOS, received power and delay spread are coherent with the returned path list.
11. Change a device pose, RF/array setting or carrier and run the link again. The next request must bind the new values automatically without reloading the scene geometry.
12. Switch back to outdoor mode and confirm the original Link Analysis workflow still sends requests to `/api/solve`.

**Acceptance rule:** Phase 6.3 becomes confirmed only after the user reports a real Colab PathSolver execution and provides its completion status/diagnostics. Local unit tests and mocked `Paths` tensors do not complete this phase.

## Next phase

After Phase 6.3 is confirmed, proceed to Phase 6.4 / indoor analytics: expose indoor path diagnostics and channel outputs in the reusable analysis panels, then separately validate radio-map coverage. Do not start that work before the real classroom PathSolver run is confirmed.

## Sionna RT API reference

The tensor handling is based on the Sionna RT 2.0.1 PathSolver and `Paths` documentation:

- [Sionna RT 2.0.1 — Path Solvers](https://propagamap.github.io/sionna-rt/api/paths_solvers.html)
- [Sionna RT 2.0.1 — Understanding the Paths Object](https://propagamap.github.io/sionna-rt/developer/dev_understanding_paths.html)

In particular, `synthetic_array=True` traces one geometric source/target at each radio-device centre while preserving antenna-port channel coefficients for the array response.
