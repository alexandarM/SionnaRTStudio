# Geospatial Alignment Release Notes

## Added
- Live scene anchor and geometry-envelope handoff from the React app to Field Validation.
- WGS84 GPS → Studio local ENU transform using the same WGS84 local-radii method as `src/utils.ts`.
- EPSG:4326 → an appropriate metric CRS for the selected study area coordinate output using pyproj.
- Scene-envelope counts, GPS centroid offset from scene anchor, ENU/UTM bounds and GPS altitude summary.
- Georeferenced CSV export preserving every original source field and row.
- Explicitly blank scene Z where the vertical datum is not verified.
- Stale-audit warning when the active anchor or geometry envelope changes.

## Important limitations
- Source-track provenance is external to this repository, so timestamp matching/interpolation cannot be independently audited from the joined CSV alone.
- EPSG:4326 is an assumption based on GPS latitude/longitude fields and `position_source`, not a verified original-track CRS declaration.
- The selected metric projection is a reference output, not the solver coordinate system.
- Scene membership uses the rectangular geometry envelope, not exact mesh/road point-in-polygon checks.
- Radio Identity & Transmitter Matching and calibrated measured-versus-simulated SS-RSRP validation are outside the scope of this module.

## Validation performed in this build
- Backend compile.
- Pytest regression suite.
- Unittest regression suite.
- WGS84→ENU anchor and axis-sign unit tests.
- Metric-CRS audit/export unit tests.
- TypeScript/TSX transpile syntax pass.
- Full Colab browser/runtime verification remains pending.
