# Measurement-Location Ray Tracing

## Scope

Measurement-Location Ray Tracing takes one manually selected radio-identity profile and one manually selected scene transmitter, then runs a batched Sionna RT PathSolver dispatch from the selected base-station transmitter to a bounded set of UE receivers placed at georeferenced measurement locations.

This is a **downlink BS→UE** propagation experiment. It is separate from the NR PHY Simulation PUSCH uplink PHY experiment.

## Pipeline

1. Resolve the selected radio-identity profile (RAT, PCI, band, NR-ARFCN, and LTE-anchor context where applicable).
2. Keep only records eligible for spatial validation.
3. Group duplicate GPS fixes by rounded WGS84 coordinates and aggregate RF metrics using medians.
4. Sort unique positions by time and select evenly spaced indices with deterministic temporal stratification.
5. Convert WGS84 locations to the same local tangent ENU frame used by SionnaRTStudio.
6. Exclude locations outside the supplied rectangular scene envelope and report the excluded count.
7. Derive carrier frequency from the selected profile's NR-ARFCN when available. Otherwise use the application RF frequency and report any disagreement with TX inventory metadata.
8. Build the scene from active buildings/materials, configure the selected TX array and UE array, place UE receivers at fixed AGL height, and orient the TX from its configured beam azimuth/elevation.
9. Run one batched PathSolver dispatch for the selected TX and sampled UE positions.
10. Return per-point path metrics and a CSV export.

## NR-ARFCN frequency

The implementation uses the NR global frequency raster ranges:

- `0..599999`: 5 kHz raster, `F(MHz) = N × 0.005`.
- `600000..2016666`: `F(MHz) = 3000 + (N − 600000) × 0.015`.
- `2016667..3279165`: `F(MHz) = 24250.08 + (N − 2016667) × 0.06`.

The effective carrier is calculated from the selected profile at runtime; this guide does not publish the carrier or radio identifiers from any private measurement campaign.

## TX selection

The user explicitly selects one TX from the candidate list. Candidate ranking is a review aid based on frequency-band metadata, geometric distance, and antenna boresight. It does not prove serving-cell identity. The workflow never silently assigns an observed PCI to a TX.

## Receiver model

- One isotropic receive port (`1×1` array) in the current baseline workflow.
- Fixed height above local scene ground (default `1.5 m AGL`).
- GPS altitude is not used for scene Z unless its vertical datum is verified.
- The physical modem antenna pattern, cable loss, and receive-chain calibration are not automatically modeled.

## Output fields

The response can include dataset/profile metadata, selected TX metadata, scene frequency, sample-selection strategy, unique/inside/outside position counts, valid/no-path status, median Sionna total RX power, and per-location rows containing:

- source row IDs and timestamp range;
- WGS84 latitude/longitude and scene ENU coordinates;
- measured RSRP/RSRQ/SINR medians (metadata, not RT inputs);
- simulated Sionna total received power and channel gain;
- LOS/NLOS state, path count, RMS delay spread, and strongest-path data.

## Radiometric limitation

Do **not** subtract modem SS-RSRP from Sionna total received power and call the result an RSRP residual. The modem reports a reference-signal measurement; this RT output sums resolved path powers under configured TX/array/power assumptions. Define the NR reference-signal resource mapping, calibrated TX reference (conducted power/EIRP, antenna gain, feeder loss), UE receive antenna/chain, and comparable Sionna metric before interpreting bias/MAE/RMSE.

## Limits and safeguards

- Maximum 100 unique GPS locations per run; start with a small controlled sample and scale only after runtime validation.
- No automatic site/sector assignment.
- One selected TX per run, allowing repeats with alternate candidates under identical settings.
- No-path results use `simulationValid=false` and null power values, not a fabricated numeric floor.
- The active Sionna solve lock serializes execution with other RT solver tasks.
- A successful API response confirms software execution, not antenna calibration or physical validation.

## Acceptance

Pure-logic tests cover ARFCN conversion, duplicate-position aggregation, deterministic stratified selection, and scene-envelope filtering. Live GPU/Mitsuba PathSolver execution must be confirmed in a compatible Colab runtime. Use [`testing/colab/MEASUREMENT_LOCATION_RAYTRACING_COLAB_TEST.md`](testing/colab/MEASUREMENT_LOCATION_RAYTRACING_COLAB_TEST.md).
