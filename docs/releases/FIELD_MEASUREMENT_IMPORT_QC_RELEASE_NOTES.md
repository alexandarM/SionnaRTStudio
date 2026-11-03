# Field Measurement Import & Quality Control — Release Notes

## Added

- New **Field Validation** top-level application tab.
- Quectel and GPS-joined CSV import (UTF-8/BOM; comma/semicolon/tab detection).
- Backend measurement parser with source-row preservation and per-record QC flags.
- Summary statistics for time, RAT, PCI, band, ARFCN, RSRP, RSRQ, SINR and WGS84 coordinate bounds.
- Filtered row endpoint and enriched QC CSV export.
- Bounded in-memory dataset store (8 datasets; max 25 MiB per CSV).
- Regression tests covering Quectel fields, sentinels, aliases, duplicates, missing GPS, filters and export.

## Explicit limitations

- Datasets are not persisted to disk; re-import after backend restart/Colab runtime reset.
- Source-track provenance is external to this repository; timestamp interpolation and GPS offset cannot be independently verified from the imported CSV alone.
- No scene CRS/ENU transformation or control-point validation is included yet.
- No PCI/ARFCN serving-cell reconciliation, simulation matching, calibration or measured-vs-simulated RMSE/MAE is included yet.
- RSRP is the first QC validity gate; other metrics are independently flagged and summarized.

## Test status

- Backend unittest suite: see final build report.
- Python compile check: see final build report.
- TypeScript transpile syntax check: see final build report.
- Full Vite build: not claimed unless dependencies are installed and the build is completed.
- Live Colab/Browser acceptance: required after deployment by the user.

Verified in the build environment:

- `pytest -q`: **182 passed**.
- `python -m unittest discover -s backend/tests -p 'test_*.py'`: **157 passed**.
- `python -m compileall -q backend`: passed.
- `bash -n run.sh setup.sh`: passed.
- TypeScript compiler `transpileModule` syntax parse: **27 TS/TSX files, zero syntax diagnostics**.
- Manual import/QC/export checks were performed with a local validation dataset that is not distributed with this repository; dataset-specific counts and coordinate statistics are intentionally omitted.

Not verified in this build environment:

- Full `tsc --noEmit` and Vite production build: frontend dependencies (`react`, `vite`, `lucide-react`, Leaflet/Three typings and Node typings) are not installed in this extracted archive environment. TypeScript syntax parsing is not a substitute for full type-checking or bundling.
- Import of `backend.main` and live FastAPI/Colab acceptance: Mitsuba is not installed in this build environment. The pure measurement parser, QC, filtering and export module is covered by unit tests; live API and browser checks must be run in the user's Colab runtime.
