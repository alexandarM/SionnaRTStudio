# Channel Matrix Persistence Fix

## Problem

After `Solve All Pairs · Sionna RT` completed, clicking a cell in the `Tx × Rx Link Matrix` caused the complete matrix to disappear.

## Root cause

`App.tsx` had a solve-results invalidation effect that depended on `activeTxId` and `activeRxId`. Selecting a matrix cell updates those IDs, so the effect treated a UI selection as a physical solve-input change and cleared `matrix`, `paths`, `metrics`, the radio map, and mobility results.

The active-device Lat/Lon ↔ ENU synchronization effects also ran when the active IDs changed and could create fresh device objects, triggering the same invalidation path even when the position had not changed.

## Fix

- Introduced `src/lib/solveContext.ts` with a canonical solve-context key based only on physical solve inputs: scene/buildings, TX and RX configurations, carrier frequency, solver depth/options, and material configurations.
- The result invalidation effect now depends on this key. `activeTxId` and `activeRxId` are deliberately excluded.
- Active TX/RX coordinate synchronization skips selection-only changes and ignores sub-millimetre round-trip noise.
- Selecting a pair in the matrix focuses that pair's cached paths and metrics without deleting the matrix.
- Selecting a TX or RX from the device selector reuses the matching cached pair when available. Otherwise it clears only the focused single-link readout while preserving the all-pairs matrix.
- A real geometry, scene, RF, material, or solver-configuration change still invalidates stale solve results.

## Regression check

Run:

```bash
npm run check:link-matrix-persistence
```

The check verifies that selection-only state is not part of the solve-context key, a real TX movement changes the key, and sub-millimetre ENU round-trip noise does not count as a geometry edit.

## Colab manual acceptance

1. Load a scene with at least two TXs and one RX (or one TX and at least two RXs).
2. Run `Solve All Pairs · Sionna RT` until the matrix is populated.
3. Click every populated matrix cell in succession.
4. Confirm that the matrix remains visible and the active border follows the selected pair.
5. Confirm that the focused link metrics and 3D rays update for the selected pair.
6. Switch active TX/RX from the device selectors; confirm cached pair results are reused where available and the matrix remains visible.
7. Move a TX/RX, change its antenna/power/beam, edit buildings/materials, or change carrier/solver settings. Confirm that stale matrix results are invalidated.

## Validation status

Backend regression tests are unchanged by this frontend-only fix. The TypeScript/TSX transpile check and the focused solve-context regression script should be run as part of packaging. A full Vite production build requires frontend dependencies to be installed; a browser/Colab click-through test remains necessary.
