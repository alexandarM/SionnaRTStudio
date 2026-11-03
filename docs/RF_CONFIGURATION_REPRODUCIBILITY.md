# RF Configuration & Reproducibility

## Purpose

The RF Configuration & Reproducibility workflow records the effective configuration used by a ray-tracing experiment and attaches a stable fingerprint to the run and its exported rows.

## Configuration snapshot

The snapshot should capture, where applicable:

- effective carrier frequency and whether it came from the selected NR-ARFCN or the application setting;
- TX power, power-reference status, position, and height rule;
- TX/RX array size, antenna pattern, polarization, and beam settings;
- interaction switches, maximum path depth, path samples/source, and seed;
- UE height above local ground;
- software/runtime metadata and calibration warnings.

The recorded values are the effective inputs resolved by the application, not necessarily verified physical calibration values. The physical calibration status remains incomplete until the required device, antenna, feeder, and power-reference metadata is independently established.

## Reproducibility workflow

1. Select the measurement profile and TX manually.
2. Review the full RF snapshot before running the solver.
3. Run a small controlled sample with a fixed seed.
4. Repeat with identical inputs and confirm the configuration fingerprint is identical.
5. Change one solver/RF parameter at a time and confirm the fingerprint changes.
6. Export results and confirm each row carries the run fingerprint.
7. Preserve the anonymized settings and software versions needed to reproduce the run.

## Scientific safeguards

- A matching fingerprint means the recorded inputs match; it does not prove the physical inputs are calibrated.
- TX candidate ranking does not prove serving-cell identity.
- Sionna total received power is not automatically equivalent to modem SS-RSRP.
- No bias, MAE, or RMSE should be reported before a like-for-like reference-signal and receiver model is established.
- Use spatially separated holdout data for validation; adjacent correlated points should not be randomly split and treated as independent.

## Privacy

Do not publish raw route coordinates, coordinate bounds, precise TX locations, radio identifiers, private measurement filenames, or unredacted exports. Public examples should use synthetic or anonymized values.

## Acceptance

Use [`testing/colab/RF_CONFIG_REPRODUCIBILITY_COLAB_TEST.md`](testing/colab/RF_CONFIG_REPRODUCIBILITY_COLAB_TEST.md).
