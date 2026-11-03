# Spatial Association & Geolocation

## Purpose

Spatial Association & Geolocation adds spatial interpretation and geolocation tools on top of the existing
Radio Coverage Analytics RadioMapSolver analytics and Channel Analysis on-demand PathSolver workflow. It is
a post-processing and visualization release: it does not introduce a new RF
solver and does not change the existing RadioMapSolver/PathSolver physics.

## 1. Cell-to-TX association map

`CoveragePanel` now contains an interactive, canvas-rendered 2D top view of the
radio-map cells. The selectable layers are:

- RSS serving sector (`RadioMapCell.servingTx`)
- Best per-TX SINR sector (`RadioMapCell.bestSinrTx`)
- Best path-gain sector (`RadioMapCell.bestPathGainTx`)
- Dominant interferer (`RadioMapCell.topInterfererTx`)

Each TX has one deterministic categorical hue, derived from its stable TX ID
(FNV-1a hash), so its colour does not change merely because the TX array order or
band-filtered subset changes. The same hue function is used by the 3D categorical
radio-map layer. The map legend reports sector names and the cell count assigned
to each sector. TX positions are drawn as labelled crosses. Unassociated cells
are grey.

Clicking a map cell selects it, shows its ENU and WGS84 coordinates, and focuses
the 3D camera on that point. A vertical pin and ground ring identify the selected
cell. The marker is a visualization only; it does not modify the scene or start a
new solve.

## 2. WGS84 georeference snapshot

The `RadioMapGrid.geoReference` field stores the WGS84 scene anchor captured at
the time the radio map is solved:

```ts
{
  crs: 'EPSG:4326',
  anchor: { latitude, longitude },
  method: 'WGS84_LOCAL_TANGENT_ENU',
  note: '...'
}
```

The frontend ENU conversion now uses WGS84 ellipsoid curvature at the scene
anchor (meridional and prime-vertical radii), rather than fixed metres-per-degree
constants. This is a local tangent-plane conversion intended for local-area
scenes such as a campus. It is not a replacement for a full projected CRS
workflow on city- or regional-scale scenes. For larger areas, use a projected
CRS such as the appropriate UTM zone and a verified transformation pipeline.

The saved map anchor is used for coordinates even if the user later moves the
active map anchor. This prevents already-calculated map cells from silently
moving to a different real-world location in the UI. If an older map has no
`geoReference`, the UI falls back to the current scene anchor and displays a
warning.

**Geolocation caveat:** coordinates are only as trustworthy as the georeference
anchor and scene alignment. The Google Maps pin marks the centre of a simulated
radio-map cell, not a surveyed receiver location or an address-level ground
truth point. Grid spacing, OSM alignment, height datum and scene origin all
contribute to the positional uncertainty.

## 3. Weak-cell candidate selection

The candidate API accepts two new query parameters:

- `association_scope=all|rss_serving|sinr_serving`
- `selection_mode=strict_topk|spatially_distributed`

`rss_serving` restricts candidates to cells whose strongest native RSS belongs
to the selected TX. `sinr_serving` restricts candidates to cells whose best
per-TX native SINR belongs to the selected TX. Cells with no positive valid
association are excluded from these serving footprints.

`strict_topk` returns the actual first K rows after ranking (lowest SINR,
lowest RSS, or highest interference). `spatially_distributed` preserves the
previous behaviour: it selects evenly spaced entries from the full ranked list
to avoid returning only adjacent cells from one contiguous weak patch. The
backend endpoint retains `all` + `spatially_distributed` as defaults for API
compatibility. The UI defaults to the more targeted `rss_serving` +
`strict_topk` settings.

Candidate scope and link-solver TX mode are distinct. For example, a SINR-best
footprint can be selected, but `serving_and_interferer` still traces the
RSS-serving sector and its strongest non-serving interferer. Use `selected`
TX mode when the selected candidate sector itself must be traced.

## 4. Geographic location actions

Candidate cards display ENU and WGS84 latitude/longitude. Each card supports:

- Mark in 3D — focuses the 3D camera and shows the selected-cell pin.
- Google Maps — opens the point using the public Maps URL format; no Maps API
  key is required for this URL handoff.
- Copy — copies `latitude, longitude` for pasting into a map/search tool.

The selected cell in the 2D association diagram provides the same Google Maps
and copy actions.

## 5. CSV exports

Two geolocated exports are available:

1. **Full geolocated radio map CSV** — one row per radio-map cell, with ENU,
   WGS84 latitude/longitude, Google Maps URL, radio KPIs and RSS/SINR/path-gain/
   dominant-interferer TX associations.
2. **Weak-cell candidate CSV** — selected sector, criterion, association scope,
   selection mode, ENU, WGS84, Google Maps URL, RSS, SINR, SNR and interference.

Both exports include comment lines identifying the WGS84 anchor and warning
that the conversion is a local tangent-plane transform.

## 6. Backend endpoint compatibility

The candidate endpoint remains:

`GET /api/radiomap/{map_id}/sector/{tx_index}/samples`

New optional query parameters are `association_scope` and `selection_mode`.
The CSV endpoint accepts the same options. Existing callers that omit the new
parameters retain the legacy `all` + `spatially_distributed` behaviour.

## 7. Verification status for this archive

Confirmed in the build environment:

- `python -m pytest backend/tests -q`: **138 passed**.
- `python -m unittest discover -s backend/tests -p 'test_*.py' -q`:
  **113 passed**.
- `python -m compileall -q backend scripts`: passed.
- `bash -n run.sh setup.sh scripts/runtime-env.sh`: passed.
- TypeScript/TSX transpile parse: **29 files, 0 syntax diagnostics**.
- WGS84 ENU round-trip, axes, local-scale and stable-colour runtime checks:
  passed.

Full `npm run lint` (`tsc --noEmit`) and `npm run build` were not completed
because `npm ci` did not finish installing dependencies in the build
environment. Do not interpret transpile parsing as a full TypeScript typecheck
or Vite production build.

`check:georeference` verifies WGS84 ENU round trips around the configured scene anchor, axis signs,
local metre scales and stable sector colours when TX ordering changes. Run it
with the project's installed development dependencies:

```bash
npm run check:georeference
npm run lint
npm run build
```

Live Sionna RT runtime acceptance remains the user's Colab check. Spatial Association & Geolocation
itself does not need another ray-tracing pass to draw an association map or
convert an existing cell coordinate.

## 8. Colab Spatial Association & Geolocation smoke test

After replacing the project ZIP and restarting the app:

1. Recompute one radio map so the result captures the current scene WGS84 anchor.
2. In `Cell-to-Sector Association`, switch through RSS serving, best SINR, best
   path gain and dominant interferer. Confirm the TX legend and markers match
   the sectors used for that map; each sector should keep its colour.
3. Click a cell. Confirm its WGS84/ENU coordinates appear, the 3D scene shows
   the amber locator, and the camera focuses the selected cell. Switch away
   from and back to the 3D view to verify the initial focus is retained.
4. Open Google Maps and compare the pin with the known scene anchor / control
   point. Do not interpret the pin as surveyed ground truth until the scene
   georeference has been checked.
5. In Channel Analysis, test `all`, `rss_serving` and `sinr_serving` footprints
   with both strict Top-K and spatially distributed selection. Confirm strict
   weak-SINR/weak-RSS candidates are correctly ranked and footprint candidates
   belong to the selected TX association.
6. For a SINR-serving footprint, use the `Selected sector only` TX mode if the
   intention is to trace that selected SINR-best sector. The default
   `serving_and_interferer` mode still traces RSS-serving plus its strongest
   non-serving interferer.
7. Export the full radio-map CSV and weak-cell candidate CSV. Check that each
   row contains ENU, WGS84 latitude/longitude and a Google Maps URL, and that
   the first comment lines identify the anchor and local-transform caveat.
8. Run a small one-cell Channel Analysis only if validating that the selected
   location is still linked to the expected Channel Analysis PathSolver context. The
   2D map, marker, coordinate conversion and CSV exports do not require a new
   ray-tracing call.
