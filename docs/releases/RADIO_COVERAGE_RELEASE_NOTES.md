# Radio Coverage Analytics — Advanced Radio Map Analytics Release Notes

## Advanced Analytics

- Cell-to-sector association layers for strongest RSS, best native SINR, and best path gain, including explicit unassociated cells.
- 3D categorical display modes for RSS-serving sector, best-SINR sector, best-path-gain sector, and dominant interferer.
- A detailed, on-demand Sector Inspector with RSS/path-gain/SINR/SNR/interference/SIR/INR distributions, CDFs, histograms, radial profiles, and three association shares.
- Per-sector table metrics for isolated SNR, interference, SIR, INR, association shares, and dominant-interferer footprint.
- A top-K sector-to-sector interference matrix with intra-site/inter-site classification and the derived SINR gain if an interferer were removed.
- A static leave-one-sector-out counterfactual for RSS/SINR coverage, outage, and alternate-server impact.
- Deterministic export of weak-SINR, weak-RSS, or high-interference ENU cells for later PathSolver work.
- Strict checks that prevent known different carrier frequencies from being combined in one co-channel radio-map solve.
- Detailed definitions and limitations in `docs/ADVANCED_RADIO_COVERAGE_ANALYTICS.md`.

All new detailed panels use cached per-TX RadioMapSolver outputs; they do not launch additional ray-tracing passes. The counterfactuals are static algebraic estimates, not scheduler/load simulations. The full exclusions and interpretation rules are documented in the advanced guide.

## Core Radio Map Analytics

## Implemented

- Native Sionna radio-map layers: RSS, Path Gain, per-TX SINR.
- Separate strongest-RSS serving association, strongest-path-gain association,
  and best-available-SINR association.
- Map layers: RSS, Path Gain, Effective Path Loss, Serving-cell SINR, Best
  available SINR, Interference Power, SIR, INR, and Dominance Margin.
- Coverage threshold, coverage probability, served area, reachability and
  outage over the complete rectangular radio-map grid.
- Percentiles, a 20-bin histogram, a compact empirical CDF, overlap and
  competing-sector summaries.
- Per-sector and per-site summary tables.
- On-demand per-transmitter CSV export containing per-cell native outputs and
  derived interference metrics.
- Bounded cache for per-TX export arrays.
- Radio-map solve configuration included with the result for reproducibility.

## Important interpretation notes

- RSS is not SS-RSRP or CSI-RSRP.
- Serving-cell SINR is SINR for the strongest-RSS TX; Best available SINR is a
  distinct layer and may select another TX.
- Path Gain and Effective Path Loss select the TX with the greatest channel
  gain, independently of TX power.
- Interference/SIR/INR include every other TX sent into the same Sionna solve.
  Run one co-channel carrier group at a time; do not combine different carriers
  and interpret them as co-channel interference.
- This is a static full-buffer/co-channel analysis, not a scheduler/load model.
- The map receiver is Sionna's ideal dual-polarized isotropic receiver.
- The rectangular map area is not a walkable-area or land-use mask.

## Verification status

- The uploaded Radio Coverage Analytics archive contained 103 discoverable backend tests. The
  Channel Analysis release adds 10 tests; the current combined suite contains 113 tests
  and passes in this build environment.
- Python compile checks: passed.
- Shell syntax checks: passed.
- TypeScript/TSX syntax parse: 24 files, zero syntax/transpile diagnostics.
- Full `npm run build` / `tsc --noEmit`: not completed in this environment because
  the frontend npm dependencies are not installed and the package registry/cache
  is unavailable. The earlier syntax parse does not replace the production build.
- Live RadioMapSolver run: not possible in this build environment; needs the
  user's Colab runtime and GPU. The user has previously confirmed the base
  radio-map computation itself works in Colab, but this new analytics layer
  requires validation with the current ZIP there.
- Whole-city / very-large-scene preview and memory testing has not yet been
  performed; the prior city-scale preview was only functionally checked on
  smaller scenes.
- No manufacturer-specific antenna model is assumed or introduced. Imported
  `Antenna` labels remain metadata until measured/vendor patterns are supplied.

## Related capabilities

1. Explicit 5G NR reference-signal and PHY modelling (SS-RSRP/RSRQ, CQI/MCS,
   BLER and throughput with declared NR resource assumptions).
2. Quectel/GPS field-data import and measured-versus-simulated validation.

Selected-cell PathSolver analysis is implemented in Channel Analysis; see
`docs/CHANNEL_ANALYSIS_GUIDE.md`.

## Hotfix — Dr.Jit scalar conversion in RadioMap analytics

- Fixed a post-solver failure caused by calling `float(scene.temperature)`.
  Sionna/Dr.Jit may expose this scene property as `drjit.cuda.ad.Float`, which
  must not be implicitly converted to a Python scalar.
- The effective noise temperature is now calculated once as a Python `float`,
  assigned to `scene.temperature`, and passed unchanged to the analytics
  function. This preserves the exact noise model and does not change any
  RadioMapSolver or physical simulation parameter.
- Regression suite at the original Dr.Jit hotfix stage was recorded as 115 tests.
  The currently supplied archive contains 103 baseline tests; the Channel Analysis release
  adds 10, and the combined discoverable suite passes 113/113.
- Python compile and shell syntax checks passed.
- A live GPU RadioMapSolver run still needs confirmation in the user's Colab
  runtime; this build environment does not contain Sionna RT/Dr.Jit.
