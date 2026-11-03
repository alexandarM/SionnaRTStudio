# Field Measurement Import & Quality Control

## Scope

The **Field Validation** workspace imports modem measurement CSV files, preserves source rows, normalizes radio/location fields, flags invalid values, provides summaries and filtered previews, and exports an enriched QC CSV.

The module does not by itself verify the provenance or interpolation of a GPS track, transform points into the active Sionna scene, resolve serving-cell identity, calibrate RF parameters, or establish measured-versus-simulated accuracy.

## UI capabilities

- Import UTF-8/UTF-8-BOM CSV files with comma, semicolon, or tab delimiters.
- Keep raw and GPS-enriched datasets as separate imports.
- Select and refresh imported datasets.
- Inspect source-row count, valid/invalid RSRP, valid GPS, and spatial eligibility.
- Review time span, RAT/band/ARFCN/PCI distributions, and coordinate bounds.
- Inspect RSRP/RSRQ/SINR descriptive statistics.
- Filter by RAT, PCI, valid RSRP, and spatial eligibility.
- Export an enriched CSV with QC status columns.

Imported datasets are held in a bounded in-memory backend store (up to 8 datasets; each CSV is limited to 25 MiB). They survive tab navigation but are cleared after backend restart or Colab runtime reset. Re-import after a restart.

## Backend API

- `POST /api/measurements/import?filename=<name>` — raw UTF-8 CSV request body.
- `GET /api/measurements` — list in-memory datasets.
- `GET /api/measurements/{dataset_id}` — summary and preview.
- `GET /api/measurements/{dataset_id}/rows` — paginated filtered rows.
- `GET /api/measurements/{dataset_id}/export.csv?spatial_only=false` — QC export.

## Canonical fields

`timestamp_utc`, `timestamp_local`, `rat`, `pci`, `band`, `arfcn`, `earfcn`, `rsrp_dbm`, `rsrq_db`, `sinr_db`, `rssi_dbm`, `lat`, `lon`, `altitude_m`, and `position_source`.

Common aliases such as `timestamp`, `datetime`, `technology`, `physical_cell_id`, `rsrp`, `rsrq`, `sinr`, `latitude`, `longitude`, `altitude`, `lng`, and `long` are also recognized.

## QC rules

- Original CSV fields and rows are preserved; import does not rewrite source measurements.
- Known sentinel values (for example, `-32768` and `-9999`) are flagged as invalid.
- Plausibility bounds are initial QC heuristics, not modem-sensitivity specifications or 3GPP conformance thresholds.
- `radioValid` requires numeric, non-sentinel RSRP within the configured broad QC range.
- `locationValid` requires latitude and longitude within valid geographic ranges.
- `eligibleForSpatialValidation` requires valid RSRP, valid GPS coordinates, and a parseable timestamp.
- Duplicate timestamps are flagged and retained; they are not automatically deduplicated.
- GPS positions are identified as externally sourced using `position_source`. The original source track and merge procedure are needed to independently audit timestamp matching/interpolation.

## Dataset-specific results are intentionally not published

No user field-measurement CSV, exact coordinate range, route extent, measurement timestamp range, private radio identity, or dataset-specific row count is included in this repository. Use the Colab acceptance procedure in [`testing/colab/FIELD_MEASUREMENT_IMPORT_QC_COLAB_TEST.md`](testing/colab/FIELD_MEASUREMENT_IMPORT_QC_COLAB_TEST.md) with synthetic, public, or anonymized data. Do not copy private dataset statistics into public documentation.

## Coordinate and validation limitations

Latitude/longitude are treated as WGS84 geographic coordinates only when supported by source metadata. The active Sionna scene uses a local ENU anchor. Before comparing data with the scene, verify the source datum, anchor, axis orientation, scene height reference, and independent control-point residuals. Do not use GPS altitude as scene Z unless the vertical datum is verified.

## Related workflows

- **Geospatial Alignment:** audit source CRS assumptions, scene anchor, ENU transform, and geometry envelope.
- **Radio Identity & Transmitter Matching:** inspect radio identity contexts and review candidate TX geometry without claiming automatic serving-cell identity.
- **Measurement-Location Ray Tracing:** sample the simulated channel at a bounded set of georeferenced positions.
- **RF calibration and spatial holdout:** compare like-for-like quantities only after modem reference-signal and simulated metrics have been reconciled.
