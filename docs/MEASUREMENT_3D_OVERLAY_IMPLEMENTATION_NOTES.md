# Measurement 3D Overlay — Implementation Notes

## Data flow

1. The backend returns eligible measurement rows with retained source-row identity and WGS84 latitude/longitude.
2. The frontend groups coincident coordinates for the grouped view or preserves one marker per source row for individual/all-record views.
3. The active scene anchor is used to reproject positions into the local ENU frame.
4. RF summary values are computed only from valid records; invalid values remain null and are visibly flagged.
5. The 3D layer renders markers without modifying the scene mesh or solver state.

## Interaction behavior

- Grouped markers expose aggregate metrics and the full list of coincident source records.
- Individual markers preserve source-row identity and timestamp.
- Hide/show toggles visibility without deleting source data.
- Center/reframe fits the currently selected points.
- Anchor or dataset changes invalidate/recompute the overlay to avoid stale positions.

## Privacy and test data

No field campaign's coordinates, route bounds, source filenames, record counts, or transmitter IDs are intentionally included in this implementation note. Unit tests use synthetic fixture coordinates and identifiers. For public acceptance testing, use synthetic, public, or anonymized datasets and redact maps/screenshots.

## Validation

Use [`testing/colab/3D_MEASUREMENT_DISPLAY_MODES_COLAB_TEST.md`](testing/colab/3D_MEASUREMENT_DISPLAY_MODES_COLAB_TEST.md) for the manual Colab procedure. The expected marker counts are calculated from the selected dataset at runtime.
