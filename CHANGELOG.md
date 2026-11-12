## [Unreleased] — Phase 6.6: Indoor Channel Analysis

- Enabled the existing per-cell Channel Analysis workflow for indoor RadioMaps. The existing Coverage panel and Channel Analysis component are shared by indoor and outdoor modes; no parallel indoor analysis UI or solver was introduced.
- Added an indoor runtime adapter that resolves the exact active indoor scene session associated with the cached RadioMap, validates the TX registry, transmitter pose/power/orientation snapshot, antenna-array configuration and carrier frequency, then invokes the shared `solve_radio_map_channel_analysis()` pipeline against the live scene.
- Indoor analysis preserves the already-registered Sionna TX devices and TX antenna array. The shared batched PathSolver traces the selected map-cell RX positions in one dispatch, then restores the prior viewport RX devices and RX array in `finally`, including when solving fails.
- Reuses the existing native `paths.cir()` / `paths.cfr()` processing and existing serving, serving-plus-dominant-interferer, selected-TX and all-co-channel TX modes. Existing channel metrics, delay spread, K-factor, Doppler, AoA/AoD, CIR taps, CFR magnitude/phase handling and path summaries remain shared.
- Indoor results use `canonical_scene_local` coordinates and `positionSceneLocalM`. The shared panel shows scene-local XYZ, keeps 3D cell focusing and clipboard copy, and suppresses WGS84 conversion and Google Maps links. Outdoor requests retain their original scene rebuild, ENU coordinates and geospatial presentation.
- Added seven backend regressions for active-scene reuse, stale session/TX/frequency/array rejection, canonical coordinates, single-dispatch behavior, and RX/array restoration on both success and PathSolver failure. Added a 14-assertion `check:indoor-channel-analysis` source contract; the ZIP-only Colab launcher automatically discovers it from `package.json`.
- Validation: backend suite **298 passed + 12 subtests**; indoor Channel Analysis contract **14/14**; indoor RadioMap contract **18/18**; indoor mobility contract **26/26**; indoor PathSolver contract **30/30**; indoor Link Matrix contract **12/12**; modified TS/TSX files pass syntax transpilation. Full frontend typecheck/production build is not claimed because npm dependency installation did not complete in the packaging environment. Real Sionna RT/GPU execution remains subject to the user's Colab acceptance test.

## [Unreleased] — Phase 6.5: Indoor Trajectory and Mobility

- Connected the existing Trajectory/Mobility panel to activated indoor scenes. Indoor uses the same waypoint editor, room-loop generator, playback, scrubber, multi-TX metrics, batch mobility PathSolver and A3 post-processing as outdoor; no parallel indoor mobility system was added.
- Added `IndoorMobilityRequest` and `POST /api/scene/import/{session_id}/mobility`. The adapter validates active-scene ownership and local room bounds, applies the current TX snapshot and RX antenna-array configuration once, synthesizes the moving RX at the first waypoint, and reuses the already-active Sionna scene without reloading geometry.
- Extended the shared mobility solver with an opt-in scene-preservation mode: active indoor TX devices and arrays are retained, temporary waypoint RX devices are created for the solve, and viewport RX devices are restored afterwards. Both batch and serial fallback paths preserve the mounted RX orientation.
- Added explicit `outdoor_enu` / `indoor_scene_local` trajectory coordinate frames with backward-compatible project loading. Indoor floor-click waypoints and automatic loops use canonical scene-local metres; invalid indoor bounds never fall back to an outdoor ENU loop.
- Added indoor floor-path drawing, waypoint markers and a separate moving RX playback marker in the shared ThreeStudio view. The outdoor `/api/mobility` endpoint and outdoor scene/coordinate path remain unchanged.
- Fixed the indoor run blocker reported during Colab testing: a separate viewport RX placement is no longer required. The backend now synthesizes the mobility RX antenna device at the first trajectory waypoint and uses the waypoint list as the actual receiver positions.
- Added an indoor-only **RX height above floor** control. Floor clicks and room-loop generation use the selected height, changing the control shifts existing indoor waypoints, and old mobility results are invalidated so the next run uses the updated altitude. The outdoor height and waypoint workflow are unchanged.
- Added `check:indoor-mobility`, nine runtime tests and a 23-assertion source contract. Full backend pytest passes (**290 passed, 12 subtests**); related indoor PathSolver, RadioMapSolver, link-matrix, path-renderer, TX/RX binding and panel-lifecycle contracts pass. Full frontend typecheck/build and real Colab GPU execution remain acceptance checks because local npm dependencies are incomplete.

## [Unreleased] — Phase 6.5.2: Indoor mobility TX binding and low-speed support

- Fixed the Colab runtime failure `Indoor mobility solve failed: 'transmitters'`. `sync_indoor_scene_devices()` returns per-TX records under `deviceSync.transmitters`; the mobility adapter incorrectly read a non-existent top-level `transmitters` key. The adapter now consumes and validates the actual nested response and reports a targeted synchronization error if it is malformed.
- Updated indoor mobility test doubles to mirror the real `sync_indoor_scene_devices()` return structure, preventing the simplified mock contract from hiding this regression again.
- Lowered the shared Trajectory panel speed control minimum from 10 km/h to **0.1 km/h**, with 0.1 km/h increments and decimal-safe input parsing. Because indoor and outdoor share this panel, the new range applies to both modes.
- Reduced the path sampler's hidden minimum speed and minimum distance-per-sample floors so a low requested speed is not silently converted into a faster trajectory. Updated both indoor and outdoor request models to accept 0.1–500 km/h and reject values below the supported minimum.
- Added runtime model tests for indoor and outdoor low-speed validation and expanded `check:indoor-mobility` to cover the nested binding shape and shared low-speed sampling behavior.
- Validation: **291 backend tests + 12 subtests passed**; indoor mobility contract **26/26**; panel lifecycle, indoor link-matrix, indoor radio-map contracts and Python compile checks passed. Full frontend typecheck/build remains unavailable in this unpacked environment because `node_modules` and app type dependencies are not installed. Real Colab GPU execution remains the acceptance test.

## [Unreleased] — Phase 6.3.6: Indoor propagation path visualization fix

- Kept the single shared `drawRayPaths3D()` renderer for indoor and outdoor; no parallel indoor ray renderer was introduced.
- Indoor propagation paths are now drawn as line segments only, using the same points, LOS/NLOS colors, line material, and opacity as the outdoor path renderer. No octahedron/hexagonal marker meshes are created for indoor paths. This matches the native Sionna-style path display and avoids visually obscuring the room-scale paths.
- Preserved the established outdoor marker layer exactly: marker placement, 0.7 m octahedron radius, and detail level are unchanged.
- Added `check:path-renderer`, automatically discovered by the existing ZIP-only Colab notebook.

## [Unreleased] — Phase 6.3.5: Simplified indoor runtime binding

- Kept one active indoor Sionna scene: PathSolver requests reuse the already-loaded Mitsuba geometry and radio materials. Only the current radio-device snapshot, scene-level TX/RX arrays and carrier frequency are applied before tracing; no indoor scene XML/PLY reload occurs for Link Analysis.
- Fixed device registration to call `Scene.add()` once per `Transmitter`/`Receiver`. Sionna RT's public examples add radio devices individually; passing a Python list caused the observed `'list' object has no attribute 'name'` failure.
- Removed the server-generated device synchronization hash/token from the indoor solve handoff. The PathSolver endpoint now applies the request's current viewport device state and dispatches directly under the existing solve lock.
- Removed the post-application PlanarArray row/column introspection, RF-setting re-comparison, scene-frequency re-read and device-position re-comparison. These were repeated checks of state just constructed by the same locked request and could reject a valid active scene. Basic request validation, active-scene ownership, Sionna class-identity compatibility, shared-array dimensional compatibility, device registration and PathSolver tensor-shape checks remain.
- Updated strict test doubles so `Scene.add(list)` fails like the reported runtime, and updated PathSolver tests to prove dispatch no longer requires a frontend token or undocumented PlanarArray dimension attributes.
- Indoor-only changes: outdoor `/api/solve`, outdoor scene construction, and shared outdoor solver behavior were not modified. Local backend and source-contract checks pass; real Sionna RT 2.0.1 PathSolver execution on the user's Colab GPU is still the acceptance gate.

## [Unreleased] — Phase 6.3.4: Sionna AntennaArray identity and rollback fix

- Resolve `PlanarArray`, `Transmitter`, `Receiver`, and the expected `AntennaArray` from the concrete active Sionna `Scene` implementation instead of relying on package-root re-exports. This keeps the created arrays compatible with the exact class used by `Scene.tx_array` / `Scene.rx_array` validation and the exact radio-device classes used by `Scene.add()` after notebook/module reloads.
- Validate each constructed TX/RX PlanarArray against the active Scene's `AntennaArray` base before mutating the active scene; class-identity problems now produce a targeted diagnostic.
- Fix rollback when initial binding fails: Sionna RT 2.0.1 intentionally rejects `scene.tx_array = None` and `scene.rx_array = None`. Restore previously-empty slots through the private backing attributes, restore only array properties that were successfully changed, and preserve the original registration exception instead of allowing a rollback TypeError to mask it.
- Added strict fake Scene setters and regressions for class identity, initial registration failure, rollback to empty arrays, and original-error preservation.
- No frontend, scene geometry, ITU material, RF configuration, PathSolver algorithm, or outdoor workflow changes.

## [Unreleased] — Phase 6.3.3: Dr.Jit scene-frequency scalar conversion

- Fixed both indoor automatic device binding and PathSolver pre-dispatch validation to read `scene.frequency` through the Mitsuba/Dr.Jit `.numpy()` bridge rather than calling Python `float()` on a vectorized `mi.Float`.
- Added regression tests that mimic `drjit.cuda.ad.Float`, raise on direct `float()` conversion, and succeed through the NumPy bridge in both code paths.
- No solver options, scene geometry, TX/RX placement, antenna configuration, or outdoor solver behavior changed.

## [Unreleased] — Phase 6.3.2: Automatic Indoor TX/RX Runtime Binding

- Removed the separate manual TX/RX synchronization action from the normal indoor user workflow. Import/activation, viewport placement and Link Analysis are now the user-facing sequence.
- Extended the indoor PathSolver request to carry the latest scene-placed TX/RX models, carrier frequency and RF/array settings instead of a frontend-held synchronization token.
- Under the same backend solve lock, the PathSolver endpoint validates scene ownership, binds the current device snapshot and shared arrays into the active Sionna scene, then executes the solver. Static Mitsuba geometry and radio materials are not reloaded.
- Removed the frontend sync-token state and stale-token guard that could block Link Analysis before a request reached the backend.
- Updated Scene Import to explain automatic runtime binding and clarified the PathSolver workflow/documentation.
- Added request-model tests and updated the indoor device-binding and PathSolver contract checks. RadioMapSolver automatic binding is reserved for the indoor coverage phase.

## Unreleased — Phase 6.3.1 PathSolver response typing hotfix

- Fixed the frontend TypeScript error where indoor/outdoor solve response narrowing left `execution` typed as `unknown`.
- Added a runtime type guard for the indoor PathSolver execution metadata and explicit handling of an unexpected response payload.
- Added two PathSolver frontend contract assertions. No backend solver logic, tensor handling, or outdoor solve dispatch was changed.

# Changelog

## [Unreleased] — Phase 6.4: Indoor RadioMapSolver

- Enabled indoor radio-map coverage using the existing shared `solve_radiomap()` / Sionna `RadioMapSolver()` pipeline, shared Coverage Solver panel, association view, 3D radio-map renderer, cached sector analytics, interference analysis and exports. Indoor requests reuse the already-active Sionna scene and scene-local TX devices; no outdoor OSM scene rebuild is performed.
- Added indoor scene-local map plane height and room-scale grid resolution controls. Indoor cell geometry, TX markers, focus markers, CSV exports and sample exports preserve canonical scene-local metre coordinates and do not fabricate ENU/WGS84 locations or map links.
- Kept the existing outdoor `/api/radiomap` request, ENU/WGS84 export path and outdoor scene construction as the unchanged default. Per-cell CIR/CFR channel analysis remains hidden for indoor until its backend can reuse the active indoor scene rather than rebuilding an outdoor scene.
- Added six backend indoor radio-map tests and a 16-assertion source contract, including TX-only binding, active-scene reuse, local-coordinate handling, room-bound checks and shared RadioMapSolver dispatch.

## [Unreleased] — Phase 6.3.7: Indoor TX×RX Link Matrix

- Enabled the existing Link Analysis all-pairs matrix in indoor mode.
- Added `POST /api/scene/import/{session_id}/path-solve-matrix`; it binds the current placed TX/RX snapshot once and runs one native Sionna PathSolver dispatch on the already-active indoor scene.
- Extracts every application TX×RX pair from Sionna's receiver×transmitter path tensors using the same `_build_paths`, `_beamform`, and `_channel_metrics` helpers as outdoor link solving.
- Reuses the existing `MatrixCell`, matrix UI, click-to-focus behavior, 3D path overlay, and experiment logging. Indoor matrix runs can be replayed from their saved experiment request.
- Outdoor `/api/solve`, outdoor per-pair matrix loop, scene construction, and path rendering are unchanged.
- Added a 12-assertion frontend/backend source contract and runtime tests for one-TX/two-RX extraction from exactly one PathSolver dispatch.
- Indoor RadioMapSolver and trajectory/mobility remain intentionally deferred to subsequent phases; this change does not enable those controls prematurely.

## [Unreleased] — Phase 6.3: Indoor Sionna RT PathSolver

- Added a dedicated indoor PathSolver endpoint for one selected TX→RX link on the already-active indoor Sionna RT scene. The outdoor `/api/solve` endpoint and scene builder remain separate and unchanged.
- Added active/selected scene identity, current TX/RX membership and indoor runtime validation. The redundant per-request token and post-application state comparisons were subsequently removed in Phase 6.3.5.
- Connected the existing Link Analysis `Solve Link` action to the indoor endpoint when indoor mode is active; outdoor solving continues through the existing endpoint.
- Invokes the existing PathSolver adapter on the active indoor scene without reloading XML/PLY geometry. Converts Sionna `Paths` geometry, delays, angles, Doppler and complex coefficients into the app's `PropagationPath` and `ChannelMetrics` response.
- Handles `synthetic_array=True` tensor layouts explicitly: path geometry follows device-pair axes while channel coefficients retain physical antenna-port axes.
- Added separate completed/no-valid-paths reporting and scene/runtime/tensor diagnostics; does not fabricate a path when no valid paths are found.
- Disabled indoor all-pairs matrix solving in this phase; outdoor all-pairs behavior is unchanged.
- Added `check:indoor-path-solver` with 23 contract assertions and dedicated backend runtime tests. Actual Sionna RT 2.0.1 PathSolver execution in Colab remains the acceptance gate.

## [Unreleased] — Phase 6.2: Indoor TX/RX Runtime Integration

- Added an explicit API/UI action that synchronizes viewport-placed canonical indoor TX/RX devices into the active Sionna RT scene as actual `Transmitter` and `Receiver` instances.
- Converts editor `[x,y,z,w]` mount quaternions and device-local TX steering to Sionna's Z-Y-X Euler orientation, aligning the canonical +Z boresight and XY array plane with Sionna's +X boresight and YZ `PlanarArray` plane.
- Instantiates the scene-level TX/RX `PlanarArray` definitions from the current RF settings with 0.5λ spacing and validates common dimensions across each device class.
- Transfers TX conducted power, canonical scene-local positions, carrier frequency, antenna pattern and polarization; verifies device registration and positions against Sionna's runtime registries.
- Uses stable app-managed runtime names, replaces only devices created by this integration, and restores the prior device/array/frequency state when an update fails.
- Revalidates scene material frequency support when the carrier changes and rejects devices attached to a different scene session.
- Added `check:indoor-device-sync`, runtime unit tests and UI feedback that marks the prior sync stale after relevant device/RF settings change.
- PathSolver execution remains Phase 6.3; this phase does not claim to calculate propagation paths.

## [Unreleased] — Phase 6.1: Indoor Sionna RT Scene Activation

- Added an explicit staged-scene activation endpoint and runtime status/catalog APIs; preview and selection remain distinct from actual Sionna RT activation.
- Added a canonical Mitsuba runtime-scene builder that bakes source units, axis mapping, source origin, and shape-level `to_world` transforms into every mesh vertex, fixes winding for reflected transforms, and removes the baked XML transform to prevent double application.
- Preserved individual shape IDs and object boundaries with `load_scene(..., merge_shapes=False)`.
- Added explicit mapping from each referenced original XML material ID to a material in the installed Sionna RT ITU catalogue, including frequency-range validation. No default-to-concrete fallback is used.
- Verified the loaded scene has the expected object count and that every object is backed by a registered `RadioMaterialBase` before marking it active.
- Added UI for carrier frequency, per-material ITU mapping, activation status, and loaded scene/runtime details. Selecting another scene, deleting the active scene, or clearing selection unloads the active indoor runtime.
- Kept outdoor scene construction and solve paths unchanged; TX/RX attachment and PathSolver are explicitly deferred to later Phase 6 steps.
- Added seven backend tests and a `check:indoor-activation` source contract check.

## [Unreleased] — Phase 5: Indoor Antenna & RF Integration

- Added frequency-aware 0.5λ planar-array element layout previews for the active indoor TX and RX devices.
- Added element/port counts, wavelength, aperture, pattern and polarization summaries to the indoor RF panel.
- Added a TX beam elevation control and device-local indoor azimuth/elevation semantics while preserving the outdoor ENU convention.
- Added `beamSteeringFrame` metadata to frontend/backend transmitter models for the Phase 6 Sionna scene adapter.
- Added local beam-direction and antenna-array instanced rendering to the shared 3D viewport; the indicator is not presented as a radiation/gain pattern.
- Kept existing outdoor `PlanarArray`, pattern, polarization and beam-angle behavior unchanged.


This file summarizes fork-specific work. Detailed implementation notes and historical validation records are maintained in [`docs/releases/`](docs/releases/). The upstream project's original history remains in the upstream repository.

## Current fork release — Google Colab and research workflow expansion

- Added a dedicated Google Colab launcher configured for `alexandarM/SionnaRTStudio`.
- Added Colab runtime setup, backend/frontend health checks, log access, optional NR PHY installation, and optional Google Drive persistence for the SQLite experiment database.
- Expanded field-measurement import and QC, geospatial alignment, radio identity review, measurement-location ray tracing, 3D overlays, RF configuration snapshots, reproducibility fingerprints, experiment management, and repeatable workflows.
- Added automated backend regression coverage and manual Colab acceptance procedures.
- Kept private measurement files, field routes, coordinate bounds, and site-specific identifiers out of the public repository documentation and test fixtures.

## Feature notes

- [Field Measurement Import & Quality Control](docs/releases/FIELD_MEASUREMENT_IMPORT_QC_RELEASE_NOTES.md)
- [Geospatial Alignment](docs/releases/GEOSPATIAL_ALIGNMENT_RELEASE_NOTES.md)
- [Spatial Association and Geolocation](docs/releases/SPATIAL_ASSOCIATION_RELEASE_NOTES.md)
- [Radio Identity & Transmitter Matching](docs/releases/RADIO_IDENTITY_MATCHING_RELEASE_NOTES.md)
- [Measurement-Location Ray Tracing](docs/releases/MEASUREMENT_LOCATION_RAYTRACING_RELEASE_NOTES.md)
- [3D Measurement Display Modes](docs/releases/3D_MEASUREMENT_DISPLAY_MODES_RELEASE_NOTES.md)
- [RF Configuration & Reproducibility](docs/releases/RF_CONFIG_REPRODUCIBILITY_RELEASE_NOTES.md)
- [NR PHY](docs/releases/NR_PHY_RELEASE_NOTES.md)
- [Experiment Management](docs/releases/EXPERIMENT_MANAGEMENT_RELEASE_NOTES.md)
- [Repeatable Workflows](docs/releases/REPEATABLE_WORKFLOWS_RELEASE_NOTES.md)
- [Channel Analysis](docs/releases/CHANNEL_ANALYSIS_RELEASE_NOTES.md)
- [Radio Coverage](docs/releases/RADIO_COVERAGE_RELEASE_NOTES.md)


## Unreleased — Phase 1 universal scene coordinates

- Added a scene-source coordinate contract with configurable signed up/forward
  axes, handedness, units, and source origin.
- Added canonical Sionna-frame transforms, bounds preview, normal/orientation
  conversion, and a left-handed mesh-winding correction flag.
- Added backend preview API and mirrored TypeScript coordinate utilities.
- No existing outdoor scene construction, TX/RX placement, trajectory, or solver
  behavior was changed in this phase.


## Unreleased — Phase 2 Mitsuba XML/ZIP scene import and preview

- Added a safe ZIP staging and Mitsuba XML inventory endpoint. The importer
  validates referenced mesh/texture/include paths, rejects unsafe archive paths,
  XML DTD/entities, encrypted entries and symbolic links, and enforces archive
  size/entry limits.
- Added per-object geometry inventory and top-level BSDF/material inventory,
  preserving original XML IDs and reporting conservative name hints separately
  from actual Sionna radio-material registration.
- Added a canonical-coordinate GLB preview for PLY, OBJ, STL and OFF meshes using
  the explicitly selected Phase 1 source coordinate profile.
- Added a standalone Scene Import workspace, raw-ZIP browser upload, 3D orbit
  preview, coordinate profile form, material/geometry tables and staged-session
  cleanup. Import remains non-activating: the outdoor scene and Sionna runtime
  are not mutated.
- Added backend importer tests and a frontend/API contract check.

## Phase 2.0.1 — Scene Import TypeScript Fix

- Fixed the `SceneImportPanel.tsx` TypeScript error caused by passing React's reserved `key` attribute to `ImportPreview3D` in this project type-check configuration.
- Replaced the JSX `key` with an explicit `sessionId` prop and included `sessionId` in the preview effect dependency list, preserving preview cleanup/reinitialization when the staged scene changes.
- Added a Scene Import contract assertion to prevent regression of the typed session lifecycle.
- No Colab launcher changes are required. Use the same ZIP-only notebook and upload this source archive.


## Unreleased — Phase 2.1 material appearance preservation

- Replaced arbitrary hash-derived GLB preview colors with visual appearance
  resolved from Mitsuba XML BSDF definitions.
- Added diffuse reflectance, conductor specular reflectance, dielectric and
  blend BSDF approximations, including the documented Mitsuba blend weight
  convention.
- Embedded referenced bitmap textures when mesh UVs are available, preserved
  UV coordinates and explicit PLY vertex/face colors, and reported fallbacks.
- Added preview material color swatches and appearance source/texture state to
  Material Inventory.
- Added regression coverage for RGB, texture, rough conductor, blend and vertex
  color preservation. Visual GLB materials remain separate from Sionna RF
  material registration.

## Unreleased — Phase 3 persistent scene manager

- Added backend-managed indoor scene sessions with stable IDs, archive SHA-256
  fingerprints, coordinate-profile-aware cache keys, and reuse of identical
  staged imports/GLB previews.
- Added atomic staging-directory publication and persisted manifests/manager
  selection state, with rehydration after a backend-process restart while the
  configured cache directory remains available.
- Added one-current-staged-scene selection, session listing, explicit selection
  clearing, individual deletion, cache status and LRU/TTL/resource limits.
- Updated Scene Import UI to restore the selected scene after browser refresh
  and show staged-scene history. Selecting a scene remains non-activating and
  does not alter the outdoor scene or Sionna RT runtime.
- Added Scene Manager backend lifecycle tests and an automatic frontend/API
  contract check (`npm run check:scene-manager`).

## Unreleased — Phase 4 universal indoor TX/RX placement

- Added canonical scene-local device pose fields to TX/RX state without
  repurposing outdoor ENU/GPS coordinates.
- Loaded the selected staged GLB into the existing main ThreeStudio viewport,
  keeping imported geometry in a static scene group separate from dynamic
  devices and outdoor OSM preview geometry.
- Added surface raycasting for indoor placement, transformed hit normals,
  camera-facing normal correction for inconsistent mesh winding, floor/ceiling/
  wall classification, a 4.5 cm surface offset and normal-aligned device poses.
- Added selectable indoor TX/RX markers with shared Three.js Move/Rotate
  TransformControls; gizmo changes are committed back to canonical scene-local
  position, normal and quaternion.
- Kept the original outdoor click-to-place/ENU path in its own unchanged branch.
- Kept the Trajectory panel and TX inventory visible; indoor trajectory editing
  is clearly marked for Phase 8 rather than treating outdoor ENU waypoints as
  indoor-local coordinates.
- Hid outdoor tower/AGL height sliders in indoor mode because indoor mounting
  position is defined by 3D placement. Shared RF controls remain available for
  the next antenna/RF integration phase.
- Added `npm run check:indoor-placement` for coordinate/orientation math and
  source integration regression checks.
- Indoor Sionna RT activation and solver execution remain locked until Phase 6.

