# Measurement-Location Ray Tracing Release Notes

## Added

- A new `POST /api/measurements/{dataset_id}/raytrace-samples` endpoint for one selected scene TX and a bounded sample of measured GPS positions.
- Deterministic temporal stratification over unique GPS coordinates, with duplicate coordinate records aggregated using RF medians.
- WGS84→scene ENU conversion using the active scene anchor.
- Scene-envelope filtering and explicit outside-point counts.
- NR-ARFCN-to-carrier conversion using the selected radio profile at runtime.
- A batched PathSolver call for downlink BS→UE sampling at up to 100 receiver locations.
- Per-location LOS/NLOS, path count, total received power, channel gain and delay-spread metrics.
- Measurement-Location Ray Tracing UI controls for TX candidate, 25/50/100 locations and UE AGL height, plus results table and CSV export.

## Methodology safeguards

- TX candidate selection remains manual; no PCI-to-TX identity is inferred automatically.
- Modem SS-RSRP and Sionna total received power remain separate metrics. No residual, bias, MAE or RMSE is produced in this workflow.
- GPS altitude is not used for Z; the receiver uses fixed AGL height until vertical datum is confirmed.
- A no-path result is represented with null received power and `simulationValid=false`, not a numeric -200 dBm value.

## Validation performed in the development environment

- `pytest -q`: 191 passed.
- `python -m unittest discover -s backend/tests`: 166 passed.
- Python compileall: passed.
- TypeScript/TSX transpile parser: 27 files, zero syntax diagnostics.
- Parser, identity-profile, coordinate-conversion, and deterministic sampling checks were exercised with local validation data that is not distributed; private identifiers, counts, and geospatial details are intentionally omitted.

## Not yet verified

- Full Vite production build and TypeScript type-check were not run because `node_modules` are not present in this build environment.
- Live Mitsuba/Sionna RT PathSolver execution was not run in the development environment. It must be tested in the user's Colab runtime.
