# Base-station inventory import

## Scope

The **Import Base Stations** panel imports a private operator inventory directly into the running SionnaRTStudio scene. The supported file inputs are `.xlsx`, `.csv`, `.tsv` and `.txt`. The file is parsed in the browser using the File API; the original spreadsheet bytes are not sent to FastAPI or uploaded as a file to the Colab runtime.

Each non-empty spreadsheet row is treated as one transmitter/sector. The importer keeps the row's source identity and RF metadata instead of trying to infer a manufacturer-specific antenna model. Before placement, the user can select one exact Frequency Band label or choose **All antennas**. When `n78` is present, it is preselected because it is the current research focus; the other rows remain in the local preview and are not discarded.

## Column mapping

Required columns:

- `Site`
- `Longitude`
- `Latitude`
- `Height (m)`
- `Azimuth (°)`
- `Power (dBm)`
- `Frequency Band`

Recognised optional columns:

- `Transmitter` / `Sector` / `Cell Name`
- `Antenna` / `Antenna Model`
- `Mechanical Downtilt` (including clipped headings beginning `Mechanical D`)
- `Electrical Downtilt`
- exact `Carrier Frequency`, `Center Frequency` or `Downlink Frequency` with GHz/MHz units
- `Antenna Gain (dBi)`

Headers are matched case-insensitively and tolerate common punctuation/diacritic differences. Semicolon/comma/tab-delimited files and decimal commas are supported. Invalid data rows are reported with their spreadsheet row numbers and the file is not partially imported.

## Coordinate placement

The importer converts longitude/latitude using the app's existing `latLonToENU` transform and the current `GeoAnchor`. OSM building footprints use the same conversion, so both layers share the same local ENU frame. It does not independently transform the stations to another CRS.

Before import, use the MapSelector's place search (e.g. search for the selected study area) and establish the scene anchor in the same geographic area as the OSM selection. The panel reports the farthest station-to-anchor distance and blocks the import when it exceeds 100 km to avoid accidentally projecting the selected study area coordinates around the starter demo anchor. Do not change the anchor after downloading the OSM scene unless the scene geometry is also reprojected/reloaded.

## Height datum

The table heading `Height (m)` does not tell the software which vertical datum is used. The user must choose one interpretation:

- **AGL:** height above local ground. The current scene assumes flat ground at local Z=0 because no terrain elevation model is connected to the importer.
- **Above roof:** height above the roof of the building footprint containing the station coordinate.
- **Absolute local scene Z:** the value is used directly as the scene's vertical coordinate.

Legacy/manual transmitters without a `heightReference` retain the pre-existing roof-plus-offset behaviour.

## Power semantics

The user must declare whether `Power (dBm)` is conducted TX power or EIRP. If it is EIRP, the importer requires a per-row antenna gain or a common gain entered in the panel, then converts `conducted power = EIRP - antenna gain`. The source power and reference type are retained in metadata. No gain is guessed from the antenna name.

## Orientation and antenna model

Azimuth is stored using the app convention (clockwise from North). Positive mechanical/electrical downtilt is converted to negative beam elevation. The 3D panel preview uses the corresponding North/East orientation and downward tilt.

The `Antenna` column is kept as metadata only. The current Sionna RT scene has one shared TX antenna array/pattern configured in RF Controls, not an independent manufacturer pattern for every imported row. No specific antenna vendor/model (including AIR 3278) is assumed by this importer.

## Frequency integrity

Band labels are preserved verbatim. The importer deliberately does **not** infer a channel centre from labels such as `n78`, `GSM 900`, or nominal frequencies written in an LTE band name. Add a separate exact carrier/centre/downlink frequency column when the channel is known, or select one band group and explicitly set/confirm the actual downlink carrier in RF Controls before a RadioMap solve.

RadioMapSolver uses one carrier frequency for a scene. Different bands/carriers must not be aggregated as though they were co-channel interferers. The importer can place just one band group or all antenna rows for visualization. After an all-antenna import, the Coverage panel still requires one Frequency Band group at a time for a radio-map solve. The just-imported single band is automatically selected in Coverage. If a group contains multiple exact carriers, the solve is blocked until the rows are separated more precisely.

## What is added to the scene

- A unique transmitter ID for every data row.
- `Site` and transmitter label metadata.
- Latitude/longitude and ENU position.
- Height and declared vertical datum.
- Conducted TX power passed to Sionna, plus original source power metadata.
- Frequency band and optional exact carrier frequency metadata.
- Azimuth, mechanical/electrical downtilt metadata and resulting beam target.
- Antenna model text as metadata.

The MapSelector displays the imported positions, ThreeStudio renders a schematic preview of all imported transmitter rows, and the existing TX list makes individual transmitters selectable. The preview panels/cones are not calibrated antenna radiation patterns.

## Validation status and limitations

- Import parser checks cover header aliases, clipped `Mechanical D`, locale decimal commas, unique TX IDs, exact-frequency parsing, no band-to-carrier inference, height datum, downtilt, and conducted/EIRP handling.
- Backend height-datum tests cover AGL, roof-relative, absolute scene Z and legacy behaviour.
- The existing backend regression suite passes.
- The actual private spreadsheet was not supplied or uploaded; its real data rows have not been tested. The user can import it locally without sharing it.
- Very-large/city-wide OSM scene performance has not yet been tested by the user.
- Full browser visual validation and a Vite production build still require the user's Colab/browser runtime and installed npm dependencies.

## Band selection behaviour

- The import panel lists every distinct `Frequency Band` label exactly as it appears in the spreadsheet, with a row count.
- `n78` is preselected when the label exists; otherwise `All antennas` is selected.
- Selecting one label places only rows whose label exactly matches it. This avoids silently merging distinct carrier/bandwidth groups (for example, two different Band 3 inventory labels).
- `All antennas` places every valid row in the 3D scene. It does **not** make a multi-band radio-map solve valid: choose one band in Coverage for each solve.
- The anchor distance check and selected-row preview apply to the current band selection.
- If a single band is imported, that band is automatically selected in Coverage. An untagged starter TX outside the selected group does not contaminate that band's RadioMap solve.
