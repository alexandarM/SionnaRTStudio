# Measurement-Location Ray Tracing — Colab Acceptance Test

> **Privacy:** Use synthetic, public, or anonymized measurement points and a test scene. Do not publish route geometry, exact GPS coordinates, private transmitter IDs, raw CSV exports, or maps/screenshots from a private field campaign.

## 1. Preparation

1. Start SionnaRTStudio with the Colab launcher and confirm `/api/health`.
2. Install optional PHY dependencies only when testing NR PHY workflows; measurement-location RT itself uses the RT solver path.
3. Import a georeferenced test dataset and run Geospatial Alignment and Radio Identity audits.
4. Re-import the dataset after a backend restart because the current measurement store is in memory.

## 2. Select a test profile and transmitter

1. Choose a radio identity profile present in the imported dataset.
2. Review candidate transmitters against the test scene inventory.
3. Manually select one candidate. Candidate ranking is advisory and must not be treated as proof of serving-cell identity.
4. Confirm that the effective carrier is derived from NR-ARFCN metadata when available; otherwise the application RF frequency is used and any mismatch is reported.

## 3. Controlled sampling run

1. Start with a small sample (for example, 25 unique locations).
2. Use a fixed seed and record the solver settings: max depth, path samples/source, UE AGL height, TX/RX arrays, antenna patterns, polarization, and interaction toggles.
3. Run the batched PathSolver operation.
4. Confirm that the API returns one result row per selected sample location, with explicit valid/no-path status.
5. Confirm that records outside the active scene envelope are counted and excluded rather than silently projected into the scene.
6. Export the results locally for private analysis; do not attach the unredacted export to public issues.

## 4. Expected behavior

- The sample selection is deterministic for unchanged inputs and seed.
- Duplicate coordinates are aggregated according to the documented median rule.
- A no-path result has `simulationValid=false` and null power values, not a fabricated floor value.
- Returned metrics include path count, LOS/NLOS status, received power/channel gain, and delay-spread fields when available.
- Solver execution is serialized with other RT jobs where required by the application.

## 5. Interpretation safeguards

- TX selection remains manual; no automatic PCI-to-TX identity is claimed.
- GPS altitude is not used as scene Z unless its vertical datum is verified.
- Sionna total received power is not automatically equivalent to modem SS-RSRP/CSI-RSRP.
- A successful API response proves that the software path ran, not that the physical antenna, power reference, serving cell, or propagation model is calibrated.
- Do not calculate bias, MAE, or RMSE until measured and simulated quantities are physically comparable.

## Evidence

Record anonymized run IDs, settings, software/runtime versions, and pass/fail. Redact coordinates, TX labels, radio identifiers, map imagery, and any measurement export before sharing evidence.
