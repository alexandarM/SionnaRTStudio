# Field Measurement Import & Quality Control — Colab Acceptance Test

> **Privacy:** Use a synthetic, public, or anonymized dataset. Do not commit private GPS tracks, raw modem exports, exact coordinates, base-station inventories, or screenshots that expose a route or device/network identifiers. Expected counts and coordinate bounds are dataset-dependent and are intentionally not published here.

## Purpose

Validate CSV import, source-row preservation, quality flags, filtering, export, and in-memory persistence in a Google Colab runtime.

## 1. Deploy and start

1. Start the project using `SionnaRTStudio_Colab_Launcher.ipynb`.
2. Confirm `GET /api/health` returns `ok: true`.
3. Open **Field Validation**.

## 2. Import a GPS-joined dataset

1. Select a test CSV containing radio measurements and GPS coordinates (for example, `your_measurements_with_gps.csv`).
2. Wait for import and summary display.
3. Confirm the reported source-row count matches the input file.
4. Confirm valid/invalid RF counts, valid GPS count, time span, RAT distribution, and coordinate bounds are populated from the imported file.
5. Apply RAT/PCI and validity filters. Confirm the filtered preview and count update consistently.
6. Inspect records flagged for missing, sentinel, or implausible RF values. Original values must remain visible and must not be silently rewritten.
7. Confirm duplicate timestamps are flagged when applicable and source rows are retained.

## 3. Export QC results

1. Export with **Spatially eligible only** enabled.
2. Confirm the export contains the expected QC columns:
   - `validation_radio_valid`
   - `validation_location_valid`
   - `validation_eligible_for_spatial_validation`
   - `validation_quality_flags`
3. Confirm the exported row count matches the filtered eligible set, plus the CSV header.
4. Export again with the spatial-only filter disabled and confirm all original source rows are represented.
5. Check that original source fields and values are preserved.

## 4. Import a raw dataset without GPS

1. Import a second CSV that contains RF fields but no location columns (for example, `your_raw_measurements.csv`).
2. Confirm that the importer reports zero valid GPS positions and that no ENU/scene position is fabricated.
3. Confirm that RF-valid records can still be inspected independently of spatial eligibility.

## 5. Persistence and regression

1. Navigate to other tabs and return to **Field Validation**. Datasets should remain available while the backend process is alive.
2. Restarting the backend clears the current in-memory measurement store; re-import is expected.
3. Confirm Radio Map, Channel Matrix, and optional NR PHY panels still open normally.

## 6. Evidence and privacy

Record pass/fail, runtime type, and any error message. Screenshots must hide/crop exact coordinates, map tiles, route shapes, filenames, phone/modem identifiers, IMSI/IMEI, and network identifiers. Do not upload raw measurement files or full exports to public issues. A redacted summary and `/api/health` output are sufficient for a public bug report.

## Not covered

This procedure does not independently verify the provenance or time interpolation of a GPS track, serving-cell identity, physical TX mapping, RF calibration, or measured-versus-simulated accuracy metrics. Those require separate evidence and a like-for-like radio measurement model.
