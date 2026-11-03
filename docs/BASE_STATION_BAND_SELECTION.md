# Base-station band selection

The Import Base Stations panel now has a **Band to place in the 3D scene** selector.

- `n78` is preselected when the spreadsheet contains that exact label.
- Every other distinct `Frequency Band` label is available as an individual option, with its row count.
- `All antennas — all bands` places every valid spreadsheet row.
- The selected row count and a preview are shown before the import.
- The anchor-distance validation is computed for the selected rows, not for unrelated bands.
- Importing one band automatically selects that group in Coverage.

This selector filters which transmitter rows are created in the current scene. It does not infer exact carrier frequency from a band name and does not change antenna patterns. `n78`, for example, still requires the actual deployed downlink carrier to be entered in RF Controls unless an exact carrier-frequency column was included in the private spreadsheet.

When `All antennas` is selected, all bands can be visualized together, but RadioMapSolver must still be run for a single compatible band/carrier group at a time. Bands that do not share a carrier are not co-channel interferers.

The spreadsheet continues to be parsed locally in the browser; the original private file is not uploaded.
