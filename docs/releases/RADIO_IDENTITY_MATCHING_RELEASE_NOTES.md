# SionnaRTStudio — Radio Identity & Transmitter Matching Release Notes

## Added

- Radio identity profile generation by RAT, PCI, band, ARFCN and LTE-anchor context.
- Candidate transmitter comparison using active scene TX ENU coordinates, explicit frequency-band metadata and beam boresight.
- Measurement context summary, LTE-anchor context table and sampled row preview in Field Validation.
- Matching audit stale-state warning when anchor, geometry envelope, TX position or TX azimuth changes.
- `POST /api/measurements/{dataset_id}/matching-audit` endpoint.

## Scientific safeguards

- No automatic serving-cell/site identity claim.
- LTE `cell_id` and `earfcn` are labeled as anchor context for NR NSA records.
- No direct modem RSRP vs simulated total received-power comparison.
- No fabricated vertical coordinate or validation error metrics.

## Validation

- Backend tests: see the acceptance report delivered with this release.
- Parser/profile grouping checks were exercised with local validation data; private radio identifiers, counts, and location details are intentionally omitted.
- No Mitsuba/GPU ray tracing was executed by Radio Identity & Transmitter Matching; this module provides data profiling and geometry-based TX candidate review only.
- Full Vite build is not claimed unless frontend dependencies are installed in the build environment.

## Next

Measurement-Location Ray Tracing: controlled Sionna RT channel sampling at measurement ENU coordinates for a manually reviewed TX/sector mapping. Begin with 25–50 unique points, then scale after runtime validation.
