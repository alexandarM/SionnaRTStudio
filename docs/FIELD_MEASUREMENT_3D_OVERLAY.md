# Field Measurement 3D Overlay

## Purpose

The Field Measurement 3D Overlay displays georeferenced measurement records in the active 3D scene. It uses the active scene anchor to transform retained WGS84 latitude/longitude into local ENU coordinates.

## Display modes

### Unique GPS locations (grouped)

Rows sharing the same geographic coordinate (using the configured grouping precision) are represented by one marker. The marker summary uses median RF metrics from valid source rows at that location, while the inspector retains the individual source records.

### Individual measurements

Each eligible source row is represented by a marker. Records sharing the same coordinate remain colocated; the visualization must not shift them horizontally to make them easier to see. A count badge/inspector identifies coincident records.

### All imported records

This mode can include rows that have invalid or missing RF metrics, provided they have valid geographic coordinates. Invalid RSRP values must be represented as unavailable/invalid, not as fabricated signal levels. The valid-RSRP-only filter should update the display consistently with Field Validation.

## Behavior and persistence

- The overlay remains visible when switching between Field Validation and 3D Scene.
- Hide/show controls alter visibility without deleting source data.
- Center/reframe controls fit the selected points.
- Changing the scene anchor reprojects markers from the retained geographic coordinates.
- Selecting/importing another dataset invalidates stale overlays.
- The overlay does not modify scene geometry, RF solver inputs, antenna configuration, or original CSV rows.

## Interpretation limits

- Marker height is a display offset, not GPS altitude or terrain snapping.
- Grouped RF values summarize valid records at a shared coordinate; the popup should preserve the individual measurements and timestamps.
- Individual/all-record modes represent source CSV rows. Invalid RF records are neutral/gray when included.
- A marker is a georeferenced observation location, not proof of point-in-mesh membership or serving-transmitter identity.
- Do not publish private route maps, exact coordinates, or unredacted screenshots.

## Validation

See [`testing/colab/3D_MEASUREMENT_DISPLAY_MODES_COLAB_TEST.md`](testing/colab/3D_MEASUREMENT_DISPLAY_MODES_COLAB_TEST.md). Expected marker counts are derived from the selected test dataset and are not stored as fixed repository values.
