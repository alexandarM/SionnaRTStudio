# Radio Map View Persistence

## Behaviour

The computed `RadioMapGrid` remains owned by `App.tsx` and is not invalidated by
switching the Studio mode between `Radio Coverage`, `Link Analysis`, and
`Trajectory`.

The Three.js `heatmapGroup` is now treated as a persistent scene layer:

- `Radio Coverage`: the existing layer is visible.
- `Link Analysis` / `Trajectory`: the layer is hidden but retained in the scene.
- Returning to `Radio Coverage`: the same GPU layer is shown again without
  rerunning `RadioMapSolver` or rebuilding the instanced cell mesh.
- `radioMap === null`: the old layer is disposed and its render snapshot reset.
- A different radio-map result or changed map display setting: the layer is
  rebuilt from the new data/settings.

This preserves the current 3D camera and the selected radio-map display mode
while switching the left-side Studio mode tabs. It does not change solver
configuration, cache contents, radio-map calculations, or Channel Analysis.

## Manual acceptance test

1. Open the scene and calculate a radio map in `Radio Coverage`.
2. Change the 3D view to a categorical association mode and/or select a weak
   cell so that the rendered map has a recognisable state.
3. Switch to `Link Analysis`. The radio-map layer should be hidden while the
   link-analysis scene remains usable.
4. Switch back to `Radio Coverage`. The same map, association mode, cell marker,
   and camera view should reappear immediately; no new radio-map solve should
   start and the map result should retain the same `mapId`.
5. Repeat with `Trajectory` and return to `Radio Coverage`.
6. Change a radio-map display setting while in `Radio Coverage`; the visual
   layer should update normally.
7. Change a simulation input that intentionally invalidates the map; returning
   to `Radio Coverage` should not display the stale map.

## Scope note

This persistence applies to the Studio mode tabs (`Link Analysis`, `Radio
Coverage`, `Trajectory`). Switching the top-level navigation away from the 3D
Scene can unmount the Three.js viewport; the radio-map result itself remains in
application state and is rendered again when the 3D Scene is mounted.
