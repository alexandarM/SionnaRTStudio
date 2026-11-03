# 3D Measurement Display Modes — Colab Acceptance Test

> **Privacy:** Use synthetic or anonymized measurements. Do not publish a route map, exact coordinates, raw GPS CSV, precise marker counts from private data, or screenshots that reveal the study area.

## Preparation

1. Start the application from the Colab launcher and confirm backend/frontend health.
2. In **Field Validation**, import a GPS-georeferenced test dataset.
3. Run the radio identity matching audit and select a profile available in that dataset. Do not use fixed PCI, cell, ARFCN, or TX identifiers from a private network.
4. Open **3D Scene** and confirm the intended scene is loaded.

## Mode 1 — Unique GPS locations (grouped)

1. Select the unique-location/grouped display mode.
2. Show the selected measurements in 3D.
3. Expected: one marker per unique eligible coordinate in the selected profile. The marker count must match the unique-coordinate count shown by the audit, not a hard-coded repository value.
4. Hover a marker representing multiple rows. The inspector must show the source-record count and the associated RF observations.
5. Confirm the marker colour and summary metrics follow the documented aggregation rule (median of valid samples at that coordinate).

## Mode 2 — Individual measurements

1. Select the individual-measurement display mode.
2. Show the selected profile's eligible records in 3D.
3. Expected: one marker per eligible source row. Coincident rows retain identical geographic coordinates and are not artificially displaced.
4. Hover a coincident location and confirm the inspector lists all records sharing that coordinate.

## Mode 3 — All imported records

1. Select **All imported records**.
2. Set RAT and PCI filters to **All** and disable the valid-RSRP-only filter.
3. Show the filtered records in 3D.
4. Confirm that records with invalid or missing RSRP remain visible with a neutral/invalid style and are not assigned fabricated signal values.
5. Enable **Show only records with valid RSRP** and render again. The invalid-RSRP records should be excluded; the displayed count must match the active filter summary.

## Cross-mode checks

- Switch between **Field Validation** and **3D Scene**; the overlay should persist.
- Hide/show controls change visibility without deleting source data.
- Center/reframe controls frame the currently selected points.
- Changing the scene anchor reprojects markers from retained WGS84 coordinates.
- Importing/selecting another dataset clears stale overlays.
- The overlay does not alter scene meshes, solver inputs, antenna parameters, or original CSV rows.

## Interpretation limits

- Marker height is a display offset, not GPS altitude or a terrain snap.
- Grouped marker metrics summarize valid source rows at the same coordinate; the inspector should retain the individual readings.
- A marker shows a georeferenced measurement location. It does not prove point-in-mesh membership or serving-transmitter identity.

## Public evidence

Record the pass/fail state for each mode. Crop or blur map tiles, precise marker positions, coordinate values, route shapes, timestamps, and private radio identifiers before sharing screenshots.
