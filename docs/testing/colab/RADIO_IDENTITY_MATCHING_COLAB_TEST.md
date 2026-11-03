# Radio Identity & Transmitter Matching — Colab Acceptance Test

> **Privacy:** Select profiles from synthetic, public, or anonymized test data. Do not publish real PCI/cell context, transmitter inventory IDs, exact coordinates, TX distances, route maps, or unredacted candidate tables from a private network.

## Setup

1. Start SionnaRTStudio using the Colab launcher.
2. Import a test measurement CSV in **Field Validation** and run **Geospatial Alignment Audit** when the dataset includes GPS.
3. Open **Radio Identity & Transmitter Matching** and run the identity audit.

## Test 1 — Profile construction

1. Confirm that identity profiles are grouped by RAT, PCI, band, NR-ARFCN, and LTE-anchor context where applicable.
2. Select a profile present in the imported dataset; do not use hard-coded identifiers from a private dataset.
3. Confirm the selected profile summary and preview agree with the filtered source rows.
4. For NR NSA records, confirm LTE `cell_id` and `earfcn` are clearly labeled as LTE anchor context rather than an NR global cell identity.
5. Confirm an empty or missing transmitter inventory does not prevent identity profiles from being returned.

## Test 2 — TX candidate geometry

1. Confirm the active scene TX list is visible in the candidate table.
2. Verify that candidate records show median/P90 distance, bearing to the measurement point cloud, and beam-azimuth difference when available.
3. Confirm frequency-band metadata is treated as **match**, **mismatch**, or **unknown**; missing metadata must never be reported as a match.
4. Change a TX position or beam azimuth and confirm the prior audit is marked stale or recalculated.

## Test 3 — Interpretation safeguards

Confirm the UI explicitly states:

- PCI is not a globally unique base-station identity.
- LTE anchor fields do not establish an NR gNodeB identity.
- TX ranking is heuristic and does not automatically map a radio profile to a physical transmitter.
- Measured modem RSRP is not automatically comparable with Sionna total received power.

## Evidence

For a public issue, share redacted screenshots and anonymized counts only. Do not upload radio inventories, raw CSV files, precise GPS locations, or full candidate tables. Include the `/matching-audit` status/error response only after removing private identifiers.
