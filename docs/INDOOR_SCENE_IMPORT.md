# Phase 2 — Mitsuba XML/ZIP scene import and preview

## Scope

Phase 2 adds a non-activating importer for a scene archive containing one Mitsuba
XML `<scene>` document and its referenced resources. It stages the archive,
validates resource references, inventories top-level BSDFs and shape objects,
converts supported mesh preview geometry into the canonical coordinate frame
from Phase 1, and returns a browser-viewable GLB preview.

**This phase does not call `sionna.rt.load_scene`, register radio materials, or
replace the active outdoor scene.** The current outdoor scene, TX/RX state, solver
state and renderer remain untouched.

## User workflow

1. Open the **Scene Import** workspace.
2. Upload a ZIP containing exactly one Mitsuba XML scene and all relative mesh,
   texture and include resources referenced by that XML.
3. Explicitly select the source up axis, forward axis, units, handedness and
   optional source origin. There are no implicit Y-up/Z-up or metre defaults.
4. Select **Import and preview**.
5. Inspect the canonical Z-up / metre preview, scene bounds, geometry inventory,
   material inventory and warnings.
6. Clear the staged preview to release its temporary server-side files.

## API

### `POST /api/scene/import/preview`

The request body is the raw ZIP (`Content-Type: application/zip`). Query fields:

- `filename`
- `up_axis`, `forward_axis`
- `units` (`m`, `cm`, `mm`, `ft`, `in`, `custom`)
- `handedness` (`right`, `left`)
- `custom_scale_to_meters` when `units=custom`
- `origin_x`, `origin_y`, `origin_z`

The JSON response includes:

- an in-memory `sessionId` and staged source archive name;
- detected Mitsuba XML path/version;
- shape counts and per-object source IDs, filenames, materials, mesh counts
  and canonical bounds;
- top-level material IDs, BSDF types, reference counts and conservative
  name-derived hints (a hint is not an ITU/Sionna registration);
- verified referenced resources and texture count;
- the explicit source coordinate frame and canonical transform metadata;
- `previewUrl` for the generated GLB when all supported preview meshes load.

Related routes:

- `GET /api/scene/import/{session_id}` — read the staged manifest;
- `GET /api/scene/import/{session_id}/preview.glb` — download the canonical GLB;
- `DELETE /api/scene/import/{session_id}` — remove the staged session.

## Validation and safety limits

- One Mitsuba `<scene>` XML per ZIP.
- ZIP upload limit: 250 MiB.
- Maximum 10,000 entries, 250 MiB per entry and 1 GiB total uncompressed data.
- Absolute paths, traversal paths, Windows drive paths, duplicate entries,
  encrypted entries and symbolic links are rejected.
- XML DTD/entity declarations are rejected.
- Every referenced mesh, texture or include path must resolve inside the ZIP.
- Source geometry is transformed using the user-selected Phase 1 frame before
  it is written to the GLB preview. Left-handed source geometry has triangle
  winding reversed for the preview.
- PLY, OBJ, STL and OFF mesh preview formats are supported. Other Mitsuba shape
  types remain in the inventory as unsupported and are reported as warnings.
- Common Mitsuba `to_world` matrix/translate/scale/rotate operations are applied.
  Unsupported transform operators are reported; they are not silently claimed
  to have been applied.
- Included XML fragment files are path-validated and staged, but nested fragment
  objects are not expanded into the Phase 2 inventory yet.
- The GLB preview resolves common Mitsuba visual BSDF properties into glTF PBR
  materials: nested `twosided`, diffuse/rough-diffuse reflectance, rough
  conductor specular reflectance, dielectric approximations, and `blendbsdf`.
  Mitsuba RGB values are retained as linear PBR factors; the UI swatch converts
  them to sRGB for display.
- Bitmap reflectance textures are embedded in the GLB when the referenced mesh
  has UV coordinates. The importer preserves the source UVs. Mitsuba bitmap
  textures marked `raw=true` are re-encoded for glTF sRGB sampling. If a texture
  has no usable UVs, it uses an average texture color and reports the fallback.
- Bitmap UV transforms are not yet applied in the preview; the importer reports
  this instead of silently claiming exact texture placement.
- Explicit PLY vertex/face colors are preserved rather than overwritten by the
  XML material tint. The preview inventory reports the resolved appearance
  source and any texture/BSDF preview warnings.
- The glTF PBR conversion is an appearance approximation, not a pixel-identical
  Mitsuba renderer. In particular, a texture-driven `blendbsdf` weight is
  reduced to its spatial mean for the single-material GLB preview; a warning is
  emitted. This visual conversion does not register Sionna RF radio materials.
- The source archive's electromagnetic/radio material definitions remain
  separate from the visual preview and will be validated in the later Sionna RT
  activation/material phase.

## Test commands

```bash
python -m pytest backend/tests -q
npm run check:scene-coordinates
npm run check:scene-import
npm run lint
npm run build
```

Manual development verification with the user's classroom archive produced
161 previewed PLY shapes, 18 declared/referenced top-level materials, 162
referenced resources including one texture, 30,556 vertices, 56,188 faces and a
non-empty GLB preview. The archive is not bundled in the source ZIP. Its aggregate
bounds include all archived geometry, including the larger `Plane.ply`; they are
not the room-only bounds.

## Exit criteria for Phase 2

- Upload ZIP succeeds without changing the active outdoor simulation.
- Source coordinate profile is required and shown in the result.
- All shape and material references resolve; missing resources fail clearly.
- Geometry preview and inventories match the archive.
- Clear session removes the staged files.
- Full backend test suite, frontend TypeScript check and Vite build pass in Colab.

Sionna RT scene activation and real radio-material registration are explicitly
reserved for later phases.

## Phase 2.1 — Material appearance preservation

- Replaced the temporary hash-derived preview palette with Mitsuba BSDF-based
  appearance resolution.
- Preserved nested diffuse reflectance and conductor specular reflectance,
  approximate metallic/roughness properties, and common wrapper/blend BSDFs.
- Embedded referenced bitmap textures into GLB when source UVs are available;
  retained UV coordinates and reported average-color fallback when they are not.
- Preserved explicit source PLY vertex/face colors.
- Added material preview swatches and source/texture status to the Material
  Inventory table.
- Added tests for linear RGB factors, bitmap texture/UV round-trip,
  rough-conductor and blend semantics, and embedded PLY vertex colors.
- Preview materials remain visual glTF approximations; no Sionna RT radio
  material registration or scene activation is performed in Phase 2.1.

## Phase 2.0.1 maintenance fix

The preview component receives an explicit `sessionId` prop (rather than JSX `key`) and restarts its Three.js preview effect when the staged session changes. This avoids a TypeScript JSX attribute incompatibility while preserving lifecycle cleanup.
