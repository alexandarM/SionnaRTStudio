# Experiment Management — Release Notes

## Added

- **Run History:** SQLite-backed history with status, UTC timestamps, duration, seed, configuration snapshot, SHA-256 fingerprint, result summary, error and replay metadata.
- **Configuration Presets:** save, apply and delete named RF configurations; names are case-insensitively unique.
- **Experiment Comparison:** compare shared scalar configuration values, parameters and result metrics across selected runs; show fingerprint agreement/difference.
- **Automatic Result Logging:** integrated for single-link solve, TX × RX matrix, radio map, mobility, Link KPI, NR PHY sweep, sampled measurement ray tracing and Channel Analysis.
- **Cancel / Retry:** cooperative cancellation for background PHY and measurement-location RT jobs; replay creates a separate history record. TX × RX matrix retry is supported.
- **Validation Report:** downloadable standalone HTML with sample data, RF snapshot/fingerprint, measured and simulated values, and scientific warnings.
- Automatic history refresh on experiment changes and while jobs remain active.
- Recovery of stale `running` entries to `error` after backend restart.

## Scientific guardrail

The report intentionally does not compute SS-RSRP residuals, MAE, RMSE or bias. Current Sionna RT total received power and modem NR SS-RSRP are not equivalent observables until a reference-signal and receiver model is added.

## Cancellation boundary

Only NR PUSCH PHY and sampled measurement-location RT currently use cooperative background-job cancellation. A native GPU PathSolver dispatch cannot be interrupted in the middle of a call. Other solver endpoints remain synchronous; their records can be retried but do not yet provide true server-side cancellation.

## Persistence

Default store: `data/experiments.sqlite3`. Set `SIONNA_RT_STUDIO_DATA_DIR` to a mounted Google Drive directory before backend startup to retain history and presets across Colab runtime resets. Project-local storage survives ordinary app/backend restarts only while the folder is retained.

## Validation performed

- `python -m pytest backend/tests -q`: **196 passed**.
- `python -m compileall -q backend`: passed.
- Python syntax compilation for modified backend modules: passed.
- TypeScript transpile syntax check for 7 changed TS/TSX modules: **7/7 passed**.
- `node scripts/check-panel-lifecycle.mjs`: passed.
- Full Vite production build / full TypeScript type-check: not completed because frontend packages are absent in this environment and npm registry access is unavailable.
- FastAPI runtime smoke test: not completed because `mitsuba` is absent from this environment. Execute the acceptance procedure in the configured Colab runtime.
