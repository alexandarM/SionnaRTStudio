> **Privacy:** Use synthetic or anonymized data. Do not include private field routes, GPS coordinates, real radio/network identifiers, or unredacted screenshots in public reports.

# Experiment Management — Colab Acceptance Test

Use the complete SionnaRTStudio project archive. Keep the existing project/scene and measurement datasets; do not delete the project's `data/` folder when replacing files.

## A. Installation and storage

1. Stop the running application.
2. Extract the ZIP into the intended project directory, preserving any external persistent data directory.
3. Run the normal setup/start sequence.
4. Open the **Experiments** tab and confirm that the backend reports no connection error.
5. Run one small link solve. Confirm a new `link_solve` row appears without manually refreshing; it must contain a start time, completion time, duration, seed and 64-character SHA-256 fingerprint.
6. Restart the frontend/backend without deleting `data/`. Confirm that the run and saved presets remain.
7. Confirm that any record left in `running` when the backend restarts becomes `error` with the interrupted-run recovery message.

For persistence across a complete Colab runtime reset, mount Google Drive and set `SIONNA_RT_STUDIO_DATA_DIR` to a folder on Drive **before** starting the backend. See `docs/EXPERIMENT_MANAGEMENT.md`.

## B. Automatic Result Logging

Run or repeat these operations where the required data is already available:

- Link → Solve single link;
- Link → Solve all TX × RX pairs;
- Radio Coverage → Run radio map;
- Trajectory/Mobility → Run mobility;
- Analysis → Link KPI;
- Analysis → NR PUSCH BER/BLER sweep (requires the optional Sionna PHY package);
- Field Validation → sampled Sionna RT;
- Channel Analysis → analyse selected radio-map cells.

Expected: each operation creates a separate record. Failed runs must be retained with status `error` and an error description, not silently omitted. Background jobs first appear as `running` and update to `done`, `error` or `cancelled`.

## C. Configuration Presets

1. Set a recognizable TX/RX, frequency, max depth, solver interactions and materials.
2. Save a named preset, for example `Example n78 preset A`.
3. Change frequency, max depth and at least one solver interaction.
4. Apply the saved preset.
5. Confirm that the RF values and active TX/RX return to the saved values.
6. Confirm that scene geometry and anchor did not unexpectedly change.
7. Save another preset with the same name using different letter case; the backend must reject the duplicate name.
8. Delete a test preset and confirm it disappears from the list.

## D. Experiment Comparison

1. Run two records of the same kind with the same configuration and seed.
2. Run a third record changing only one intended parameter (for example max depth or samples/source).
3. Select at least two entries in Run History.
4. Open Experiment Comparison.
5. Confirm shared configuration, parameter and result scalar fields are visible.
6. Confirm the fingerprint indicator reports identical fingerprints for identical configurations and a difference after the changed parameter.
7. Try selecting different solver kinds; confirm that the panel allows inspection but indicates that configurations differ where appropriate.

## E. Cancel / Retry

### PHY job

1. Start a sufficiently long NR PUSCH BER/BLER sweep.
2. Confirm the Run History entry becomes `running` and includes a job ID in its expanded results.
3. Cancel from Analysis or Run History.
4. Confirm the UI first reports that cancellation was requested and later records `cancelled` when the worker reaches a safe checkpoint.
5. Confirm a new PHY sweep cannot start while the previous job is still `cancelling`.
6. Retry a completed/failed PHY record. Confirm the retry gets a new row and does not overwrite the original.

### Measurement ray-trace job

1. In Field Validation, run a sampled Sionna RT job on a small sample count.
2. Confirm a running record and a job ID appear.
3. Cancel from Field Validation or Run History.
4. Confirm the record eventually becomes `cancelled`. If the GPU PathSolver is already executing, cancellation will wait until the current native dispatch returns.
5. Retry a completed measurement ray-trace record. Confirm the retry is separately logged and can itself be cancelled.

### Replay checks for synchronous runs

Retry one Link solve, one Radio Map, one Mobility and one Channel Analysis record if their data/cache is still available. Channel Analysis replay may fail if its saved radio-map cache ID no longer exists; recompute the radio map first.

## F. Validation Report

1. Complete a sampled Measurement Ray Trace so the record contains sample-level rows.
2. Open **Experiments → Validation Report**.
3. Generate the HTML report.
4. Confirm it contains the dataset, radio profile, TX, effective carrier, RF fingerprint, full RF configuration, solver warnings and sample rows.
5. Confirm measured modem RSRP and simulated total received power are labelled separately.
6. Confirm no residual, MAE, RMSE or bias is reported as a calibrated SS-RSRP metric.
7. Open the HTML and use browser Print → Save as PDF.

## G. Regression and acceptance criteria

- Switching tabs does not lose active panel state or stop polling.
- Multiple runs with different settings create independent history rows.
- History and presets persist through an application restart when the database directory is retained.
- A backend restart does not leave stale jobs permanently marked `running`.
- Retrying an experiment creates a new record and preserves the original.
- Cancellation is available for PHY and sampled measurement RT jobs; current GPU dispatches are not interrupted mid-call.
- Validation Report preserves the scientific distinction between modem SS-RSRP and RT total received power.

## Known validation boundary in this build environment

Backend unit tests and Python compilation passed in the build environment. The changed TypeScript/TSX files passed syntax transpilation. A full Vite/type-check build could not be completed here because frontend packages (`react`, `vite`, `three`, `leaflet`, etc.) are not installed and npm registry access was unavailable. A backend API runtime smoke test could not be performed here because this environment does not have the required `mitsuba` package. Complete runtime acceptance must therefore be performed in the configured Colab environment.
