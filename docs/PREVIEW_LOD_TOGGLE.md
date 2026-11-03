# Preview LOD toggle

## Purpose

The 3D viewport now exposes a runtime `LOD On` / `Full Detail` toggle. It controls
only disposable Three.js preview geometry. It does not modify source OSM
`BuildingFootprint` data, the simulation scene, radio materials, TX/RX state,
antenna configuration, or any Sionna RT solver parameter.

## GUI behavior

- **LOD On** (default): coarse geometry is used for distant chunks; medium/high
  preview tiers are generated for nearby chunks with the existing hysteresis and
  refined-chunk residency limit.
- **Full Detail**: preview simplification and distance-based LOD refinement are
  disabled. Newly streamed chunks are built with simplification tolerance `0`,
  so their preview footprints preserve the original OSM outline points.

The existing progressive chunk streaming remains active in both modes. It still
loads chunks near/in the camera view and releases distant non-visible chunks to
bound browser/GPU memory. Therefore Full Detail means full-detail geometry for
resident/in-view chunks, not forcing every off-screen chunk in a very large city
into GPU memory at once.

Switching modes rebuilds only disposable preview chunks. Original OSM records
remain the source of truth, and rooftop hit-testing continues to use exact source
footprints. The `High` / `Eco` renderer-quality control is independent:

- For a detailed screenshot: choose **Full Detail** and **High**.
- For interactive navigation in a large city: choose **LOD On** and optionally
  **Eco**.

After switching to Full Detail, wait until the HUD no longer shows `Loading`
before capturing a screenshot. Full-detail geometry can consume substantially
more browser/GPU memory, especially when the camera shows a wide city overview.

## Implementation

- `src/components/ThreeStudio.tsx`: state, toggle control, preview-only rebuild,
  coarse chunk construction at tolerance `0` in Full Detail mode, and visibility /
  picking behavior.
- `src/lib/previewLod.ts`: `getPreviewBaseTolerance()` returns the normal coarse
  tolerance when LOD is enabled and `0` when disabled.
- `scripts/check-preview-lod.mjs`: policy assertions include both settings.

## Validation status

- Preview LOD policy checks: 26 assertions passed.
- Backend tests: 98 passed; backend was not changed by this feature.
- TypeScript/TSX transpile parse: 22 source files passed.
- Full `tsc` / Vite production build: not available in the current workspace
  because frontend dependencies are not installed here.
- Browser visual regression and screenshot comparison: not run in this workspace;
  verify in the user's Colab/browser runtime.
