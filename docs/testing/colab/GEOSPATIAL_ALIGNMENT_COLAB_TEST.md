# Geospatial Alignment — Colab Acceptance Test

> **Privacy:** Run this procedure with synthetic, public, or anonymized measurements. Do not publish precise anchors, coordinate bounds, exported GPS rows, map screenshots, route extents, or private source filenames. This repository intentionally contains no user's field route or field-measurement dataset.

## Purpose

Verify that imported WGS84 positions are transformed consistently into the active scene's local ENU frame and checked against the scene geometry envelope.

## Before testing

1. Start the application with `SionnaRTStudio_Colab_Launcher.ipynb`.
2. Confirm `/api/health` reports `ok: true`.
3. Load the OSM scene that corresponds to the test dataset. Do not use a demo anchor for a different scene.
4. Open **Field Validation** and import a GPS-joined test CSV.

## Run the audit

1. Confirm that the panel reports the active scene anchor and scene geometry bounds.
2. Run **Geospatial Alignment Audit**.
3. Confirm that every source row is preserved and that valid GPS rows receive scene ENU coordinates.
4. Confirm that rows without valid coordinates remain unlocated; do not synthesize positions.
5. Review inside/outside envelope counts and warnings. These results depend on the selected dataset, scene anchor, and geometry bounds; there are no repository-wide expected counts.
6. Verify that changing the anchor invalidates or refreshes derived results as designed.

## Export validation

1. Select **Export georeferenced CSV**.
2. Confirm that the export includes the scene ENU fields, georeference status, and `within_scene_envelope` classification.
3. Confirm that `scene_z_up_m` remains blank or explicitly unverified when the source vertical datum is unknown.
4. Confirm source RF values, timestamps, and QC flags remain intact.
5. Check a small number of rows locally against an independent coordinate transform. Do not include exact coordinates in public evidence.

## Raw CSV control

1. Import a raw RF dataset without GPS columns.
2. Run the audit.
3. Confirm there are no valid location rows and no scene coordinates are invented.

## Interpretation limits

- WGS84/EPSG:4326 is assumed only when supported by source metadata; confirm the original source CRS where possible.
- Scene ENU coordinates depend on the active georeference anchor.
- A rectangular scene envelope is a coarse spatial check, not point-in-mesh or road/sidewalk validation.
- GPS altitude must not be used as scene Z unless its vertical datum is verified.
- Successful coordinate conversion does not prove the GPS track's timestamp matching, interpolation accuracy, or positional accuracy.

## Evidence

For public reports, provide the test outcome, software/runtime versions, anonymized counts, and redacted warnings. Do not provide raw exports, coordinate ranges, screenshots containing a route, or the actual anchor values.
