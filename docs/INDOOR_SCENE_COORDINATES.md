# Phase 1 — Universal Scene Coordinate Adapter

## Status

Implemented as a standalone coordinate contract and transform layer on the clean
`main` source archive. This phase does **not** import an XML/PLY scene into
Sionna RT yet. The importer will be added in Phase 2 and must use this adapter;
it must not contain scene-specific axis assumptions.

## Design rule

An indoor scene is not synonymous with Y-up. Every imported scene carries an
explicit source coordinate profile. The current classroom is only one profile
(`+Y` up, `+Z` forward, metres, right-handed); it is not the default for other
indoor scenes.

The application/Sionna canonical frame is:

- right-handed;
- `+Z` up;
- `+X` forward;
- metres;
- configurable source origin mapped to canonical `(0, 0, 0)`.

Sionna RT documents the world `z` axis as its up direction. Radio-device
positions are three-dimensional metre-valued coordinates, and device
orientation is represented separately from position. See NVIDIA Sionna RT
Scene Objects and Radio Devices API documentation.

## Source frame contract

`SceneCoordinateFrame` currently contains:

| Field | Accepted values | Meaning |
|---|---|---|
| `upAxis` | `+X`, `-X`, `+Y`, `-Y`, `+Z`, `-Z` | Signed source direction that is vertical-up |
| `forwardAxis` | same | Signed source direction that is forward; must be perpendicular to up |
| `units` | `m`, `cm`, `mm`, `ft`, `in`, `custom` | Source linear unit |
| `customScaleToMeters` | positive finite number, required for `custom` | Metres represented by one source unit |
| `handedness` | `right`, `left` | Source frame handedness |
| `origin` | three finite numbers | Source-space point mapped to canonical origin; in source units |

There are 24 valid signed `upAxis`/`forwardAxis` combinations. Parallel or
opposite directions are rejected. All four source-profile fields (`upAxis`,
`forwardAxis`, `units`, and `handedness`) are required; the API does not silently
assume a source frame when metadata is missing. Bounds alone must not be used
to guess an up axis. Future importer UI may offer a best-effort suggestion,
but the user must inspect and confirm the profile before the scene is activated.

## Transform convention

For a source point `p_s`, source origin `o_s`, orthogonal basis transform `R`,
and unit scale `s`:

```text
p_c = s * R * (p_s - o_s)
```

The inverse is:

```text
p_s = o_s + R^T * (p_c / s)
```

Directions are rotated/reflected without translation. Unit scaling is opt-in
for dimensional vectors such as velocities. Normals are transformed and
renormalized. Orientation matrices use basis conjugation `R * Q * R^T` so a
proper physical rotation remains a proper rotation even when the source frame
is left-handed.

If `det(R) < 0`, the source-to-canonical mapping contains a reflection. A mesh
importer must reverse each triangle's winding (or equivalently correct its
orientation) after transformation. The adapter exposes this as
`requires_winding_flip`; this is not optional metadata for the importer to
ignore.

A source AABB is transformed by converting all eight corners and recomputing
the canonical AABB. Transforming only the minimum and maximum corners is not
correct for a rotated frame.

## Implemented files

- `backend/scene_coordinates.py`
  - Pydantic source-frame and bounds models.
  - Validated basis creation.
  - Source/canonical point and vector conversion.
  - Normal and proper rotation conversion.
  - Correct eight-corner bounds conversion.
  - Preview response including transform matrix, scale, determinant and
    winding-flip requirement.
- `backend/main.py`
  - `POST /api/scene/coordinates/preview` validates a frame and returns
    canonical bounds without loading Mitsuba or mutating an RT scene.
- `src/utils/sceneCoordinates.ts`
  - Equivalent pure TypeScript transform utilities for future viewport/importer
    integration. This keeps browser-side placement previews consistent with the
    backend math.
- `backend/tests/test_scene_coordinates.py`
  - Unit tests for all axis pairs, units, handedness, origin, round trips,
    normals, rotations and transformed bounds.
- `scripts/check-scene-coordinates.ts`
  - Frontend-side parity smoke test.

## Preview API example

Request:

```json
{
  "frame": {
    "upAxis": "+Y",
    "forwardAxis": "+Z",
    "units": "m",
    "handedness": "right",
    "origin": [0, 0, 0]
  },
  "bounds": {
    "minimum": [-4.08, 0.0, -4.29],
    "maximum": [4.08, 1.455, 4.26]
  }
}
```

Endpoint: `POST /api/scene/coordinates/preview`.

This example describes the current classroom only. It is not a global indoor
preset and must not be hard-coded into the importer.

## Phase 1 acceptance criteria

- [x] No global Y-up assumption.
- [x] Canonical Sionna frame documented as RH, +Z-up, +X-forward, metres.
- [x] All 24 perpendicular signed up/forward axis combinations accepted.
- [x] Parallel/opposite axes rejected.
- [x] Metric, imperial, and explicit custom unit conversion covered.
- [x] Left-handed reflection and required mesh winding reversal surfaced.
- [x] Point/vector/normal/rotation/bounds conversions covered.
- [x] Preview API does not load a radio scene or require GPU.
- [x] Backend coordinate unit tests pass.
- [x] Full backend pytest suite in the build environment: 213 passed, 12 subtests passed.
- [x] Strict standalone TypeScript check and runtime smoke test for the coordinate utility.
- [ ] Repeat full project tests and frontend build in the Colab ZIP-only runtime.
- [ ] Real XML/PLY import uses this adapter (Phase 2).

## Next phase

Phase 2 is the generic Mitsuba XML/ZIP importer and persistent indoor scene
manager. It will:

1. upload and safely extract the scene package;
2. inventory XML shapes, resource paths, BSDF/material IDs and bounds;
3. collect or confirm the source coordinate profile;
4. run the coordinate preview endpoint;
5. transform geometry/vertices, normals and winding exactly once before Sionna
   scene registration;
6. keep original source resources and transform metadata for reproducibility;
7. cache the imported immutable geometry so TX/RX/RF changes do not reparse PLY.

No TX/RX UI, antenna placement, trajectory or solver dispatch is changed in
Phase 1. Those will be added only after generic scene import is validated.
