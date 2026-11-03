# Channel Analysis — Release Notes

## Added

- Interactive selection of up to 12 exact radio-map cell centers, from automatic
  weak-SINR / weak-RSS / high-interference candidates or a manual cell index.
- Per-cell analysis modes for serving sector, serving + dominant interferer,
  one selected sector, or all co-channel sectors.
- One batched PathSolver dispatch for selected TX × RX combinations, with a
  bounded 96-pair guard, estimated CFR-allocation guard, and per-cell filtering
  of returned links.
- Exact map-scene replay using cached buildings, materials, frequency,
  transmitter models, interaction switches and max depth.
- Per-link LOS/NLOS, path count, power, RMS delay spread, Doppler, K-factor,
  path-level geometry/interactions, AoA and AoD.
- Native path-resolved CIR and native CFR magnitudes on a selected subcarrier
  grid, with meaningful single-Rx-port phase only.
- Frontend CIR delay-tap and CFR magnitude plots with path AoA/AoD table.

## Scientific / implementation notes

- The map's `isLos` remains unknown because RadioMapSolver does not expose a
  per-cell LOS attribute. LOS/NLOS is obtained from the on-demand PathSolver.
- K-factor is undefined (`null` + reason) for NLOS-only links and for LOS-only
  links with no returned scattered component.
- Multi-port Rx CFR magnitude sums receive-port powers; no single phase is
  manufactured for this MIMO aggregate.
- CIR and CFR are taken from the same native `Paths` result as path geometry;
  the analysis does not launch independent per-link tracing calls.
- The PathSolver uses a physical Rx array, while RadioMapSolver uses its own
  ideal map receiver, so their absolute values need not be identical.

## Verification status

- Backend regression suite: **113/113 tests passed** (`python -m unittest
  discover -s backend/tests -p 'test_*.py' -v`).
- Python syntax/bytecode compilation: passed.
- TypeScript/TSX transpile parse: 24 source files, no syntax diagnostics.
- Full `tsc --noEmit` and Vite production build could not be completed because
  npm dependencies are absent and the npm install did not complete in this
  environment. No successful frontend production build is claimed.
- Live Sionna RT PathSolver run: requires the user's Colab runtime; this
  container does not provide Mitsuba/Sionna RT GPU execution.
