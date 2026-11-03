# Advanced Radio Coverage Analytics — Sector and Interference Analytics

This module extends network-wide radio coverage KPIs with
cell-to-sector association, individual-sector inspection, and sector-to-sector
interference analysis. All new detailed views are calculated from the already
computed per-transmitter `RadioMapSolver` arrays held in the bounded backend
cache. Opening the panels does not invoke another ray-tracing solve.

## 1. Cell-to-sector association

For each map cell, the backend calculates three independent TX associations:

- **RSS association** — the TX with the largest received power (`rss`, W).
- **SINR association** — the TX with the largest native per-TX `sinr`.
- **Path-gain association** — the TX with the largest native `path_gain`.

These are per-cell argmax operations over the native per-TX result arrays.
They follow the same metric-specific association rule as Sionna RT's
`RadioMap.tx_association(metric)`, while retaining an explicit `-1` for a cell
where no finite positive value exists. A missing association is not silently
assigned to TX index 0.

The 3D radio-map display has categorical layers for RSS serving TX, best-SINR
TX, best-path-gain TX, and strongest non-serving interferer. Each colour maps
to a TX index. Grey denotes a cell without an association in the selected
layer; these colours are not signal-strength values.

The Coverage panel also reports the number/share of cells assigned to each TX
under the three association rules and the number of unassociated cells.

## 2. Per-sector summary and Sector Inspector

The per-sector table reports:

- RSS, network SINR, isolated SNR, interference power, SIR and INR means;
- RSS/SINR/path-gain association shares;
- RSS and SINR coverage percentages under the configured per-TX thresholds;
- top-interferer footprint;
- static leave-one-sector-out RSS/SINR coverage change;
- export of the full per-cell TX layer to CSV.

Selecting a TX opens its **Sector Inspector**. The inspector is loaded on demand
from the cache and includes mean/percentile/statistical summaries, a selectable
CDF + histogram for RSS, path gain, network SINR, isolated SNR, interference,
SIR and INR, RSS/SINR/path-gain association counts, and a radial RSS/SINR
profile from the TX's ENU position where that position is available.

### Network SINR versus isolated SNR

- **Network SINR** is the native Sionna per-TX SINR in the presence of the
  other transmitters included in the same radio-map solve.
- **Isolated SNR** is derived as `RSS_of_selected_TX / thermal_noise`; all
  other TX contributions are excluded from this denominator.

The isolated value is intentionally called SNR, not SINR. It is a derived
quantity, not a separately ray-traced Sionna output.

## 3. Dominant interferer and sector-to-sector matrix

Each cell now carries the index, received power, and share of total interference
for its strongest non-serving TX. The 3D display can be switched to the
**Dominant interferer** categorical layer.

The on-demand **Sector-to-Sector Interference** matrix is calculated for cells
whose RSS-serving TX is the victim sector. For each victim, the backend ranks
the top K non-serving sectors by received power (K defaults to 3; API allows
1–5) and reports:

- number of cells where the pair occurs in the top-K ranking;
- share of the victim sector's RSS-serving cells;
- mean dominant interferer power and mean share of total interference;
- mean per-cell SINR gain if that particular interferer were removed while
  holding desired power, all other TX powers, and noise fixed;
- Site identifiers and whether the relationship is intra-site, inter-site, or
  unknown because Site metadata is absent.

`siteRelationCounts` counts top-K pair/cell appearances, not unique map cells.
A cell may contribute several appearances when multiple interferers are in its
top-K list. Site relationship classification depends only on the imported
`Site` labels; it is not inferred from physical distance.

This is a **ranked dominant-interferer matrix**, not a full pairwise matrix of
all weak interferers. Weaker sectors are still included in total interference
and in the SINR denominators, even if they are not individually listed in the
Top-K table.

## 4. Leave-one-sector-out counterfactual

The per-sector table includes an analytical **leave-one-sector-out** estimate.
For each TX in turn, the backend removes its cached per-cell RSS contribution,
selects the strongest remaining RSS TX as server, and recomputes the
interference-limited SINR, RSS coverage, SINR coverage, outage, and server
availability over the same grid.

This calculation does not rerun Sionna RT. It is a static, full-buffer,
algebraic counterfactual: geometry, propagation, and the powers of all
remaining transmitters are held fixed. It does not represent user traffic,
resource-block allocation, scheduler behaviour, handover signalling, load
redistribution, or coordinated beam/scheduler changes. Reported changes are
percentage-point deltas for coverage, not percentages of user throughput.

## 5. Sampling candidate UE cells for later channel analysis

The Sector Inspector can export deterministic candidate locations for a later
PathSolver run:

- weakest finite network-SINR cells;
- weakest finite RSS cells;
- strongest finite interference cells.

The export includes cell index, ENU X/Y/Z coordinates, RSS, native per-TX
SINR, derived isolated SNR, and interference power. When more cells qualify
than the requested limit, evenly spaced ranks are sampled from the sorted
candidate list to avoid exporting only adjacent cells from one weak patch.
The export limit is 1–2,000 locations. These are candidate samples, not a
replacement for the full user distribution or a random traffic model.

## 6. API endpoints

All endpoints require an unexpired `map_id` from a successful radio-map run.
The per-TX cache is bounded (up to three maps / 256 MiB total in this build).
If a map is too large to cache, aggregate statistics remain in the initial
response but on-demand Sector Inspector, matrix and per-cell export are not
available for that run.

- `GET /api/radiomap/{map_id}/sector/{tx_index}/analysis`
- `GET /api/radiomap/{map_id}/interference-matrix?top_k=3` (`top_k` 1–5)
- `GET /api/radiomap/{map_id}/sector/{tx_index}/samples.csv?criterion=weak_sinr&limit=200`
- Existing per-TX export: `GET /api/radiomap/{map_id}/tx/{tx_index}/export.csv`

## 7. Carrier and RF interpretation safeguards

A radio-map solve is treated as one co-channel simulation. When TX records
contain carrier frequencies, the backend rejects a set containing multiple
different carrier frequencies, and rejects a set whose known carrier does not
match the requested solve frequency. A band label such as `n78` does not by
itself identify the carrier. Unknown carrier values are not guessed by the
backend; the operator must set the exact downlink frequency in RF Controls.

This change does not infer antenna gain from a model name or from an imported
`Antenna` label. The label remains metadata unless a supported radiation
pattern is explicitly configured. Likewise, input power/EIRP semantics remain
those of the existing TX setup and are not altered by analytics.

## 8. What this release does not claim to implement

- It does not produce SS-RSRP, CSI-RSRP, SS-RSRQ, CSI-RSRQ, CQI, MCS, BLER,
  throughput, or a scheduler/load model. Those require a separately specified
  5G NR PHY/resource-grid model.
- It does not compute CIR/CFR, delay spread, K-factor, AoA/AoD, or path counts
  from the RadioMap arrays. Those require `PathSolver` at selected locations;
  exported UE samples provide a bridge to future research workflows.
- It does not add arbitrary road/sidewalk measurement surfaces. The UI and
  area calculations still use the rectangular grid, with equal-area cells.
- It does not create different physical antenna patterns for each TX inside
  one shared scene TX array. Imported antenna model strings remain metadata;
  per-TX heterogeneous pattern solving requires a separate architecture and
  validated antenna patterns.
- It does not automatically launch multiple full radio-map solves for a
  multi-height or propagation-scenario sweep. Such comparisons require extra
  GPU runs and should retain each run's full configuration as a separate case.

These exclusions avoid presenting unsupported NR quantities, fabricated
antenna behaviour, or static map calculations as physical ray-tracing results.
