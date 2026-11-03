# Experiment Management

## Purpose

Experiment Management adds a central experiment workspace to SionnaRTStudio. The six requested capabilities share one persistent record format and one RF-configuration fingerprint mechanism. Existing solver workflows remain available; experiment logging is non-blocking and must not cause a solver run to fail if the history API is unavailable.

The new **Experiments** workspace contains four views:

1. **Run History** — inspect completed, failed, cancelled and active runs.
2. **Configuration Presets** — save and apply the active RF configuration.
3. **Experiment Comparison** — compare common configuration fields, parameters and results for two or more selected runs.
4. **Validation Report** — export a report from a sampled field-measurement ray-tracing run.

## Run History and automatic logging

The backend stores experiment records in SQLite. Each record can include:

- UUID, name, experiment kind and terminal/current status;
- UTC start and completion timestamps and measured elapsed duration;
- canonical SHA-256 configuration fingerprint;
- complete configuration snapshot, user-facing run parameters and seed;
- compact result summary, error message and replay request (when supported).

Automatic logging is integrated into these runs:

- single TX–RX link solve;
- complete TX × RX link matrix;
- radio-map / coverage solve;
- mobility solve;
- link-level KPI solve;
- NR PUSCH BER/BLER sweep;
- sampled measurement-location ray tracing;
- selected-cell Channel Analysis.

The history refreshes when a record is created or updated and periodically while an experiment remains active. Opening a run expands its configuration, parameters, result summary, error and replay metadata.

### Storage and Colab persistence

Default database path:

```text
<project-root>/data/experiments.sqlite3
```

The database directory is ignored by Git and is not included in the release ZIP. It is created automatically by the backend. It survives frontend/backend process restarts as long as that data directory is retained.

A Google Colab runtime is ephemeral. To preserve history and presets across a complete Colab runtime reset, mount Google Drive and set the environment variable **before starting the backend**:

```python
from google.colab import drive
import os

drive.mount('/content/drive')
os.environ['SIONNA_RT_STUDIO_DATA_DIR'] = '/content/drive/MyDrive/SionnaRTStudio/data'
```

Then start the application from that same notebook session. If the variable is not set, the project-local database is used. Do not delete or overwrite the chosen data directory when installing a newer project ZIP.

At backend startup, any experiment still marked `running` is changed to `error` with a restart-recovery message. Background job IDs are held in process memory and cannot be resumed after the backend process has stopped; marking these rows as interrupted avoids displaying stale jobs as permanently running.

## Configuration Presets

A preset stores the active TX and RX definitions, carrier frequency, maximum path depth, solver options, material configuration and scene reference metadata/fingerprint. Applying a preset updates the RF controls and corresponding TX/RX objects in the currently loaded project.

Applying a preset does **not** import a scene, change the scene anchor, download OSM geometry, restore a measurement dataset or recreate an expired radio-map cache. Verify scene geometry, active devices and the data profile before running a saved configuration. Preset names are case-insensitively unique.

## Experiment Comparison

Select at least two records in Run History and open Experiment Comparison. The view displays common scalar values from:

- configuration snapshots;
- run parameters;
- result summaries.

The comparison also indicates whether all selected records share the same SHA-256 configuration fingerprint. Comparisons across different solver kinds are allowed for inspection but should not be interpreted as controlled scientific comparisons. Compare runs of the same kind and change one intended variable at a time.

## Cancel / Retry

### Jobs with real cooperative cancellation

Cancellation is currently implemented for:

- NR PUSCH PHY BER/BLER sweeps;
- sampled measurement-location Sionna RT jobs.

These jobs expose a background job ID and can be cancelled from their owning panel or Run History. Cancellation is cooperative: the backend stops at safe checkpoints. A native Mitsuba/Sionna GPU PathSolver dispatch cannot be forcefully interrupted in the middle of the dispatch; the request is registered and the result is discarded after the active dispatch returns.

Other operations (single-link solve, link matrix, radio map, mobility, link KPI and Channel Analysis) currently use synchronous solver endpoints. They can be retried from a stored record, but do not yet expose server-side cancellation. Do not present closing a browser tab or aborting a client request as cancellation of the server-side computation.

### Retry behavior

Retry creates a **new** history row and leaves the original record untouched. The retry uses the saved endpoint/payload or the dedicated TX × RX matrix replay handler. The new attempt is marked done, error or cancelled and stores its own elapsed duration/results.

A saved Channel Analysis replay depends on the same radio-map cache still existing in the backend. If that cache was cleared by a backend restart or a new map computation, the retry can fail; recompute the radio map first. Measurement ray-trace retries use the background job endpoint so they can be cancelled and tracked.

## Validation Report

The report is generated from a completed `measurement_raytrace` run that contains sample-level result rows. It is downloaded as standalone HTML; open it in a browser and use Print → Save as PDF when a PDF copy is needed.

The report includes:

- dataset and radio identity profile;
- selected TX and effective carrier frequency;
- measured modem RSRP and simulated RT total received power as separate quantities;
- valid-path counts and sample-level observations;
- RF configuration fingerprint and a full RF snapshot;
- solver and data-quality warnings.

**Scientific limitation:** the current Sionna RT output is total received power summed over resolved propagation paths, whereas the Quectel modem reports NR SS-RSRP. These are not yet the same physical observable. Consequently the report deliberately does not calculate an RSRP residual, MAE, RMSE or bias and does not claim calibrated SS-RSRP validation. Such metrics should only be added after a reference-signal/receiver model makes the two quantities comparable.

## API surface

Persistent records and presets:

- `GET/POST /api/experiments`
- `PATCH/DELETE /api/experiments/{experiment_id}`
- `GET/POST /api/configuration-presets`
- `DELETE /api/configuration-presets/{preset_id}`

Background measurement-raytrace jobs:

- `POST /api/measurements/{dataset_id}/raytrace-jobs`
- `GET/DELETE /api/measurement-raytrace-jobs/{job_id}`

Background PHY job cancellation:

- existing `GET /api/phyber/{job_id}` status endpoint;
- `DELETE /api/phyber/{job_id}` cancellation endpoint.

## Operational limits

- The SQLite history is stored on the backend filesystem; it is not synced to a database service.
- A full Colab runtime reset loses project-local storage unless `SIONNA_RT_STUDIO_DATA_DIR` points to mounted persistent storage.
- Background job registries are in-memory; active jobs cannot survive a backend process restart.
- A retry can only replay data captured in its record and may depend on an in-memory radio-map cache.
- Cancellation is cooperative and currently available only for the PHY and measurement-location RT background jobs.
