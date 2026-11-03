# Geospatial Alignment Guide

## Scope

Geospatial Alignment audits an imported measurement dataset against the currently active SionnaRTStudio scene anchor and geometry envelope. It converts valid geographic positions into the scene's local ENU frame and reports which points fall inside or outside the rectangular scene bounds.

It does not perform serving-cell identity resolution, ray tracing at measurement points, measured-versus-simulated comparison, RF calibration, or validation error calculations.

## Coordinate conventions and assumptions

- Latitude/longitude are interpreted as WGS84 / EPSG:4326 only when supported by source metadata. Treat the CRS as an explicit assumption when source provenance is unavailable.
- The active Studio scene uses a local tangent-plane ENU frame: X = East, Y = North, Z = Up.
- The scene transform uses the current georeference anchor. Do not substitute WGS84 or UTM coordinates directly into Sionna scene coordinates.
- GPS altitude is retained as source metadata but is not converted into scene Z unless its vertical datum and the scene's elevation reference are verified.
- Any intermediate metric CRS must be chosen for the actual study area and declared in the export; it is not hard-coded from a development dataset.

## Scene envelope

The frontend supplies the active anchor and the min/max X/Y of the scene geometry vertices. The backend transforms each valid GPS position into local ENU and checks it against that rectangular envelope.

This is an envelope check, not point-in-mesh validation or a road/sidewalk mask. A point inside the rectangle is not proof that it lies on a modeled surface. A point outside may indicate an incorrect anchor, incomplete OSM extent, or a dataset that extends beyond the scene.

## Audit workflow

1. Load the OSM scene that corresponds to the measurement dataset.
2. Import a GPS-enriched CSV in **Field Validation**.
3. Confirm that the current scene anchor and geometry bounds are available.
4. Run **Geospatial Alignment Audit**.
5. Review valid-location, inside-envelope, outside-envelope, and warning counts. These values depend on the data and scene; do not hard-code development counts.
6. Export the georeferenced CSV and confirm source rows are preserved.
7. Validate the transformation against independent control points and, where appropriate, an independent geospatial library.

## Export fields

The export can include scene ENU coordinates, optional metric-CRS coordinates, `within_scene_envelope`, georeference anchor metadata, and an explicit vertical-datum status. If vertical datum is unknown, `scene_z_up_m` must remain blank/unverified.

## Scientific and data-provenance limits

- A `position_source` field indicates the source of coordinates but does not independently prove track interpolation accuracy.
- The original GPS logger track, timestamp offset, matching tolerance, interpolation method, and maximum gap are needed to audit a GPS join.
- GPS altitude accuracy and vertical datum must not be assumed.
- A rectangular scene envelope is a coarse spatial filter, not proof of physical correspondence with a building, street, or terrain mesh.
- Do not publish precise anchor values, coordinate bounds, route extent, or unredacted georeferenced exports from private field campaigns.

## Acceptance procedure

Use [`testing/colab/GEOSPATIAL_ALIGNMENT_COLAB_TEST.md`](testing/colab/GEOSPATIAL_ALIGNMENT_COLAB_TEST.md). The procedure uses dataset-dependent expectations and explicitly avoids publishing private route details.
