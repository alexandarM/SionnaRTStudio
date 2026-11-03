# Radio Coverage Analytics

> The advanced implementation (cell-to-sector association, Sector Inspector, top-K interference matrix, leave-one-sector-out, and UE sampling exports) is documented in [ADVANCED_RADIO_COVERAGE_ANALYTICS.md](ADVANCED_RADIO_COVERAGE_ANALYTICS.md).

## Scope

This module adds research-oriented analytics around the native outputs of
NVIDIA Sionna RT `RadioMapSolver`. It does **not** emulate a 5G NR PHY and it
does not relabel generic RSS as RSRP.

Native per-transmitter, per-cell inputs are:

- `RadioMap.path_gain` — linear channel power gain;
- `RadioMap.rss` — received power in watts;
- `RadioMap.sinr` — linear SINR for each transmitter treated as the desired
  transmitter with the other transmitters in the scene contributing
  interference.

Sionna's radio-map receiver model is an ideal dual-polarized isotropic
receiver. Results depend on the configured scene geometry/materials, TX array
and element pattern, TX orientation/precoding, frequency, and solver options.

## Map layers

| UI layer | Source / definition | Unit |
|---|---|---|
| Received Power / RSS | Native `rss` of the strongest-RSS TX at each cell | dBm |
| Path Gain | Maximum native `path_gain` across TXs at each cell | dB |
| Effective Path Loss | Negative of the maximum path gain | dB |
| Serving-cell SINR | Native `sinr` for the strongest-RSS TX | dB |
| Best available SINR | Maximum native per-TX `sinr` at each cell | dB |
| Interference Power | Sum of all non-serving TX RSS powers | dBm |
| SIR | Strongest-RSS desired power divided by summed non-serving TX power | dB |
| INR | Summed non-serving TX power divided by thermal noise power | dB |
| Dominance Margin | Strongest RSS minus second-strongest RSS | dB |

The Path Gain and Effective Path Loss layers select the strongest channel gain,
independently of TX power. RSS serving-cell association selects the TX with the
largest received power. Serving-cell SINR is the SINR of that RSS-selected TX;
Best available SINR is separately available because the strongest-RSS TX and
highest-SINR TX need not be the same.

`Effective Path Loss` is intentionally named to avoid confusing it with free-
space path loss. It is `-10 log10(path_gain)` and therefore includes the
configured TX array/element-pattern contribution contained in Sionna's
path-gain result. It is not a propagation-only path-loss decomposition.

## Derived power and noise quantities

- dBm conversion: `10 log10(power_w) + 30`.
- Thermal noise: `N = k * T_eff * B`, where `T_eff = 293 K * 10^(NF_dB/10)`
  in the current implementation. This is the Sionna scene temperature used
  for the noise calculation; bandwidth is the configured channel bandwidth.
- Interference: sum of received powers from all other TXs in the radio-map
  solve. Therefore, only transmitters intentionally grouped into the same
  carrier/co-channel simulation should be included. Different bands/carriers
  must be solved separately.
- SIR: `P_desired / P_interference`.
- INR: `P_interference / N`.
- Dominance margin: `RSS_best - RSS_second`.
- Exact zero-interference limits are represented with finite display bounds:
  - interference power / INR floor: `-300 dBm` / `-300 dB`;
  - SIR / dominance ceiling when no competing sector is detectable: `+300 dB`.
  These are display sentinels for mathematical limits, not finite measured RF
  levels. A no-signal cell remains undefined/unreachable.

These are static full-buffer/co-channel spatial quantities. They do not model
traffic activity, scheduling, resource-block overlap, load, beam scheduling,
TDD slot configuration, or dynamic inter-cell coordination.

## Coverage and statistics

- The selected metric's coverage threshold is editable in the UI.
- Separate thresholds are used for per-TX RSS coverage (default -100 dBm) and
  SINR coverage (default 0 dB).
- Coverage probability applies a direction-aware threshold over **all cells in
  the rectangular radio map grid**. Higher is better for RSS, path gain, SINR,
  SIR and dominance margin; lower is better for effective path loss, interference
  power and INR. Cells with no finite metric value count as not covered.
- Covered area is cell count multiplied by `gridSize^2`.
- The area is the computed rectangular measurement surface. It is not masked to
  pedestrian-accessible land, roads, parcels, or buildings.
- Reachable percent is the fraction of cells with a finite metric value;
  outage is `100% - coverage probability` for the selected threshold.
- P5/P10/P25/P50/P75/P90/P95, a 20-bin histogram, and the compact
  21-point empirical CDF are calculated over finite values only. The CDF is a
  quantile-compressed display curve, not the full per-cell empirical distribution.
- Mean received power is calculated as the arithmetic mean in watts over
  reachable cells and then converted to dBm. Percentiles are quantiles of the
  per-cell dBm values.
- Mean SINR is the spatial arithmetic mean of per-cell SINR expressed in dB;
  it is not the mean of linear SINR converted back to dB.
- Mean interference is the arithmetic mean in watts over the full grid and
  then converted to dBm.

## Best-server and site/sector statistics

- `servingTx` is the strongest-RSS transmitter at a cell.
- `bestSinrTx` is the transmitter with the highest per-TX SINR.
- `bestPathGainTx` is the transmitter with the highest path gain.
- Per-sector statistics include mean RSS/SINR/path gain, RSS and SINR coverage,
  serving-cell share and percentiles.
- Per-site statistics group sectors by `Site`. The site's RSS coverage is the
  union/envelope of its sectors (strongest sector at each cell), not the sum of
  all sector powers. Site serving share counts cells for which any sector at
  that site is the overall strongest-RSS transmitter. Site SINR is taken from
  the site's strongest-RSS sector at each cell, while other sites/sectors remain
  part of the interference field.
- Overlap is the percentage of grid cells where at least two TXs exceed the
  configured overlap RSS threshold (-100 dBm by default). Mean competing
  sectors is the spatial mean of the number of TXs above that threshold.

## Per-transmitter CSV export and cache

The API exposes `/api/radiomap/{map_id}/tx/{tx_index}/export.csv`. It exports
ENU cell coordinates and native per-TX path gain, RSS, and SINR, plus dB/dBm
conversions and derived interference/SIR/INR for that TX.

The backend keeps a bounded in-process cache (maximum three maps and 256 MiB)
for per-transmitter layer exports. A map can still return aggregate analytics
when its detailed cache is skipped because it exceeds the memory budget; in
that case, per-cell per-TX export is not available and the UI says so.

## Explicit exclusions and related capabilities

This module does not claim to produce SS-RSRP, CSI-RSRP, SS-RSRQ, CSI-RSRQ,
CQI, MCS, BLER, or throughput. Those require NR reference-signal/resource-grid
and PHY/link-level definitions. RSRP is not equivalent to aggregate Sionna
RSS, and RSRQ is not obtainable by merely renaming SINR.

Channel Analysis adds detailed channel metrics at selected radio-map cells through
`PathSolver`; see `docs/CHANNEL_ANALYSIS_GUIDE.md`. Additional workflows provide explicit
NR reference-signal/PHY modelling and Quectel/GPS measured-versus-simulated
validation.

## Reproducibility metadata

Every radio-map response includes the configured frequency, bandwidth, noise
figure, max ray depth, enabled interaction types, TX pattern/polarization,
grid resolution, measurement height, samples per TX, and random seed.
The application should preserve these values with exported results.

## Runtime compatibility note — Dr.Jit temperature scalar

The effective noise temperature is computed in Python as
`293 K * 10^(NF_dB/10)`, assigned to `scene.temperature`, and the original
Python scalar is passed to post-processing. Do not read `scene.temperature`
back and call `float()` on it: Sionna/Dr.Jit can expose the property as a
`drjit.cuda.ad.Float`, which is a JIT array and does not support implicit
Python scalar conversion. This handling changes no solver or RF parameter.
