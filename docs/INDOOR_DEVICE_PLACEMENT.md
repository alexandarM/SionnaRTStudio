# Phase 4 — Universal Indoor TX/RX Device Placement

## Scope

Phase 4 adds indoor device placement to the existing `ThreeStudio` viewport. It does not replace the outdoor placement path and does not activate a staged indoor Mitsuba scene in Sionna RT. Scene activation and solver execution remain Phase 6 work.

## Coordinate contract

- Imported scene geometry and device poses use the Phase 1 canonical scene frame: right-handed, metres, +Z up, +X forward.
- The current Three.js viewport remains Y-up. `src/utils/indoorDevicePlacement.ts` is the only conversion layer between the canonical frame and the viewport frame.
- No source axis (X-up/Y-up/Z-up) is hardcoded in placement. The source scene is transformed by the coordinate profile selected during import before this controller sees it.
- Every placed device stores `scenePosition`, `sceneNormal`, `sceneOrientation`, `sceneSurface`, and `sceneSessionId`. These are separate from the outdoor `enu`, latitude and longitude fields.

## Placement interaction

1. Select an existing TX/RX device in the normal device UI, or add a device from the existing inventory controls.
2. Activate `Place TX` or `Place RX` in the shared 3D viewport toolbar.
3. Click any visible imported scene surface. The raycaster targets the actual GLB mesh objects, not the ground plane or synthetic OSM footprints.
4. The hit normal is transformed with the object's world normal matrix. If mesh winding points away from the clicked side, the normal is flipped to face the user/click side.
5. The device is offset 4.5 cm from the hit surface and oriented so its canonical local +Z axis follows that surface normal.
6. Select a placed device marker to attach the Three.js transform gizmo. `Move` translates and `Rotate` changes orientation. On mouse release the canonical scene pose is saved to the device state.

The visual TX/RX markers are compact viewport representations. Detailed antenna element/array visualization is part of Phase 5, and physical Sionna RT activation is Phase 6.

## Shared RF controls

The existing RF controls remain shared. Indoor mode hides outdoor-only `TX Tower Height` and `RX Device Height` sliders: indoor mounting position and height are determined by the actual 3D placement and gizmo, not by an AGL/roof height offset. Array, pattern, polarization, power, frequency and beam controls remain available as configuration inputs; their indoor solver mapping is Phase 5/6.

The original Trajectory panel is preserved. While an indoor scene is selected, it continues to provide TX inventory management and displays a clear Phase 8 notice; outdoor waypoint authoring/mobility results are not silently interpreted as indoor-local coordinates.

## Performance and lifecycle

- The imported GLB is loaded once when the selected session identity/preview URL changes.
- TX/RX state changes do not recreate the Three.js renderer or reload the static GLB geometry.
- Device markers are separate dynamic groups; only those small marker objects are refreshed when device state changes.
- The indoor scene group, device groups and transform controls are disposed when the viewport scene is replaced/unmounted.

## Regression safety

The original outdoor path remains in the non-indoor branch: OSM ground/building raycasting, ENU click conversion, rooftop handling, outdoor TX/RX visual models and trajectory waypoint coordinate conversion are unchanged. The indoor branch exits before outdoor ENU placement logic.

## Automated checks

- `npm run check:indoor-placement`
  - canonical/Three point and direction conversion round trips;
  - floor/ceiling/wall classification;
  - six axis-aligned surface-normal orientation cases;
  - 4.5 cm placement offset;
  - source integration contract for GLB scene raycast, gizmo, local pose persistence and outdoor fallback separation.
- `npm run lint`
- `npm run build`
- `python -m pytest -q backend/tests`

## Colab manual acceptance checklist

1. Upload the Phase 4 source ZIP through the existing ZIP-only launcher. Do not clone GitHub.
2. Confirm all discovered `check:*` scripts, `tsc --noEmit` and `vite build` pass.
3. Import the classroom and select it in Scene Manager. It should appear in the main 3D Simulator viewport.
4. In `Link` mode, choose `Place TX`, click an interior floor surface and confirm a compact TX marker appears at the click point.
5. Repeat for a ceiling and a wall. The antenna/device stem should face the clicked side/interior, even when the source mesh normal winding is inconsistent.
6. Place RX on the floor and a desk/top surface.
7. Select a marker, use `Move`, then drag the gizmo. Confirm the marker remains visible at the new position after releasing the mouse.
8. Use `Rotate`, rotate the device, and confirm the pose persists after the marker redraws.
9. Change RF controls and camera orbit/zoom. Confirm the static indoor mesh does not reload or flash mesh-by-mesh.
10. Switch away and back to the same staged scene. Device poses should remain tied to that scene session; switching to a different scene must not show stale poses from the previous session.
11. Clear the indoor selection and verify the original outdoor placement/viewport behaviour is unchanged.

## Explicitly not included in Phase 4

- Sionna RT `load_scene` activation and indoor `PathSolver` execution (Phase 6).
- Indoor RadioMapSolver plane and coverage workflow (Phase 7).
- Indoor-local waypoint drawing/playback/mobility (Phase 8).
- Full indoor channel analytics (Phase 9).
