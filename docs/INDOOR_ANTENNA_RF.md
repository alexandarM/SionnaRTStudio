# Phase 5 — Indoor Antenna & RF Integration

**Status:** frontend/configuration implementation complete; Colab TypeScript/build and browser acceptance are pending. Sionna indoor solver activation is explicitly Phase 6.

## Scope

Phase 5 connects the existing RF controls to scene-local indoor devices and visualizes the configured planar arrays in the existing ThreeStudio viewport. It does not load the staged scene into Sionna RT or claim that the visual preview is a radiation-pattern simulation.

## Antenna array model

- TX and RX array dimensions use the project's `[horizontal columns, vertical rows]` convention.
- The preview lays out a centered planar grid in the device-local canonical XY plane.
- Element spacing is `0.5λ`, matching the current backend `PlanarArray` factory defaults (`horizontal_spacing=0.5`, `vertical_spacing=0.5`).
- Wavelength is computed from the selected carrier frequency in GHz.
- Element centres are rendered through a single `THREE.InstancedMesh` for the active TX/RX device. Non-active devices keep a compact array marker to avoid excessive draw calls.
- The selected-device preview shows element count, polarization-aware port count, physical aperture, antenna pattern and polarization.

## Device pose and beam steering

Indoor device pose remains stored as canonical scene-local metres and quaternion. The mounted boresight is the device-local canonical `+Z` axis, which is oriented by the Phase 4 surface-placement quaternion.

Indoor steering uses explicit transmitter metadata:

```json
{"beamSteeringFrame": "device_local", "indoorBeamSteering": {"azimuthDeg": 0, "elevationDeg": 0}}
```

For this convention:

- local azimuth `0°`, elevation `0°` points along the mounted boresight (`+Z`);
- positive local azimuth steers toward device-local `+X`;
- positive local elevation steers toward device-local `+Y`.

When an outdoor transmitter is first used in indoor mode, stale outdoor compass angles are not silently reused; its local steering starts at boresight. Outdoor transmitters retain `beamSteeringFrame="world_enu"` semantics and the existing compass azimuth convention.

The 3D arrow indicates the configured steering direction only. It is not an antenna gain pattern, an EIRP visualization, or a solved beam pattern.

## Sionna scene-level array constraint

Sionna RT assigns one `scene.tx_array` and one `scene.rx_array` to the scene. Array size, antenna pattern and polarization are therefore shared by the devices participating in a solve. The studio retains array-size configuration on each device record, but multi-device solves must use compatible dimensions; the backend's existing uniform-array checks continue to enforce this. RX array configuration applies to Link/PathSolver/CIR/CFR paths, while RadioMapSolver's receiver remains its ideal dual-polarized isotropic receiver.

## Files changed

- `src/utils/antennaArrayPreview.ts` — wavelength, 0.5λ element positions, aperture and local steering math.
- `src/components/ThreeStudio.tsx` — active indoor TX/RX array element visualization, instanced mesh and local steering direction indicator.
- `src/components/SolverControls.tsx` — RF configuration summary, beam elevation slider, device-local steering labels and array-scope note.
- `src/App.tsx` — forwards frequency/RF state to the viewport and ensures unplaced indoor devices remain scene-session-bound when RF settings change.
- `src/types.ts`, `backend/models.py` — `beamSteeringFrame` and separate `indoorBeamSteering` metadata, preserving outdoor compass angles.
- `scripts/check-antenna-rf.ts`, `scripts/check-antenna-rf-contract.mjs`, `backend/tests/test_indoor_antenna_rf.py` — geometry/configuration and regression checks.

## Validation performed in the build environment

| Check | Result |
|---|---:|
| Backend pytest | 239 passed, 12 subtests passed |
| Python compileall | PASS |
| Antenna/RF integration source contract | PASS |
| TS/TSX syntax transpilation | 43 files, PASS |
| Package check registration | PASS |
| Full TypeScript `tsc --noEmit` | Not run: npm installation timed out and `node_modules` is incomplete |
| `check:antenna-rf` runtime geometry test | Not run locally: `three` dependency is unavailable after incomplete npm install; included for Colab execution |
| Vite production build | Not run: npm installation timed out |
| Browser/WebGL inspection | Pending Colab |
| Sionna RT indoor device/array configuration | Phase 6 |

## Colab acceptance checklist

Use the existing `SionnaRTStudio_Colab_Launcher_ZIP_ONLY.ipynb` and upload the Phase 5 source ZIP.

1. Let the notebook complete `npm ci` from the ZIP's lockfile.
2. Confirm backend pytest and the automatically discovered `check:antenna-rf` test pass.
3. Confirm TypeScript and Vite production build pass.
4. Import/select the classroom and place TX/RX using Phase 4 controls.
5. Select TX and RX devices in the main viewport. Confirm the active device displays an element grid and non-active devices remain compact.
6. Change carrier frequency. Confirm the element spacing/aperture preview changes while the static GLB does not reload.
7. Change TX/RX array sizes and patterns/polarizations. Confirm the active array grid, element/port summary and metadata update.
8. Change local TX beam azimuth/elevation. Confirm the orange steering arrow rotates relative to the mounted boresight; it should not behave like a geographic compass bearing.
9. Move/rotate the device. Confirm the array grid and steering indicator follow the device orientation.
10. Switch to outdoor mode and confirm the original ENU compass steering values return unchanged; switch back to indoor and confirm the device-local offsets are restored.

## Next phase

Phase 6 will create/activate the staged Mitsuba scene through Sionna RT, register electromagnetic radio materials, convert canonical device quaternions into Sionna radio-device orientation, set `scene.tx_array`/`scene.rx_array` from the RF configuration, apply `indoorBeamSteering` in the device-local frame while retaining `world_enu` outdoors, and verify a real indoor PathSolver run. No indoor ray-tracing result is claimed by Phase 5.
