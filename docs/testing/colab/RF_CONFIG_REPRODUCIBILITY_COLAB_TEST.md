# RF Configuration & Reproducibility — Colab Acceptance Test

> **Privacy:** Use synthetic or anonymized measurements and transmitters. Do not publish field routes, GPS coordinates, radio identifiers, private TX inventory labels, or unredacted exported CSV files.

## 1. Preparation

1. Start the application using the Colab launcher.
2. Import a georeferenced test measurement dataset and select a profile available in that dataset.
3. Review the candidate TX list and manually select a test transmitter.
4. Open **Measurement-Location Ray Tracing** and confirm the available RF configuration controls.

## 2. Review RF configuration snapshot

Confirm the snapshot captures, where applicable:

- Effective carrier frequency and its source.
- TX power and power-reference status.
- Resolved TX position/height rule.
- TX/RX array size, antenna pattern, polarization, and beam settings.
- PathSolver interaction switches, max depth, samples/source, and seed.
- UE height above local ground.
- Physical calibration status and outstanding warnings.

An `incomplete` calibration status is not by itself a runtime failure; it indicates that required physical inventory or calibration metadata has not been verified.

## 3. Repeatability and convergence

Keep the selected dataset/profile/TX and all RF inputs fixed. Run the following controlled comparisons:

| Run | Max depth | Samples/source | Seed |
|---|---:|---:|---|
| A — baseline | 3 | 1,000,000 | fixed seed |
| B — depth | 5 | 1,000,000 | same seed as A |
| C — sampling | 5 | 2,000,000 | same seed as A |
| D — repeat | 3 | 1,000,000 | same seed as A |

Use a small, controlled sample and record the actual settings shown by the application. Do not change multiple parameters between comparisons.

## 4. Acceptance checks

- Runs A and D have identical configuration fingerprints when every input is unchanged.
- Run B has a different fingerprint because max depth changed.
- Run C has a different fingerprint because samples/source changed.
- Exported result rows include the run fingerprint.
- The RF snapshot distinguishes configured values from assumed or unverified physical values.
- No automatic PCI-to-TX association is claimed.
- Sionna total received power remains distinct from modem SS-RSRP.

## 5. Evidence

Share only anonymized fingerprints, RF settings, KPI summaries, and redacted warnings. Remove route coordinates, TX identifiers, PCI/cell IDs, private filenames, and map imagery before publishing evidence.
