# City-scale preview: progressive chunk loading and dynamic LOD

## Scope and safety boundary

This pipeline only manages transient Three.js preview objects. It does not
rewrite `BuildingFootprint.enuPoints`, building heights, OSM ids/categories, or
any payload sent to FastAPI/Sionna RT. It does not change carrier frequency,
transmit power, antenna arrays/patterns, radio materials, PathSolver or
RadioMapSolver settings, sample counts, max depth, or simulation grid
resolution.

The rooftop lookup index is built from the original ENU footprints and heights.
The preview pick meshes can change LOD, but height resolution remains tied to
the raw OSM footprint data.

## Chunk organization

- Default chunk width: 250 m.
- Scenes with at least 10,000 OSM features use 500 m chunks to bound chunk count.
- Features are assigned by their ENU centroid. A planar bounding sphere is
  expanded by building height so tall structures are considered by frustum
  tests even when their base is outside the view.
- Long ways / large polygons contribute to a chunk radius through all their
  original vertices, so a centroid outside the camera range does not prematurely
  hide a feature that crosses into the relevant area.

## Progressive loading lifecycle

1. Build the spatial index from original OSM features, yielding to browser RAF
   every 1,200 features and every 24 chunk bounds calculations.
2. Determine chunks that intersect the camera frustum or lie in the near-camera
   safety margin and are within the stream radius.
3. Sort coarse candidates by distance and build them in order. Each chunk is
   processed in batches of 64 features with a RAF yield between batches.
4. Revalidate each candidate after every yield because the camera can move while
   geometry is being compiled.
5. Refine nearby coarse chunks to medium or high preview detail in the background.
6. Dispose GPU geometry/material/texture resources for chunks outside the unload
   region. Original OSM features stay in CPU-side project data for later rebuild.
7. Retry a failed preview chunk with exponential backoff instead of repeatedly
   blocking the stream.

Only resident chunks are visited by the visibility/LOD updater, at 8 Hz rather
than walking all city chunks on every animation frame. The coarse candidate list
is also constructed/sorted once per pump pass rather than once per individual
chunk.

## LOD policy

| Tier | Simplification tolerance | Activation | Visual extras |
|---|---:|---|---|
| Coarse | 1.25 m / 2.0 m based on scene feature count | Default / distant | No street labels, park tree decoration, or outlines |
| Medium | 0.55 m | Within 1,550 m; retained until 1,950 m | Street labels, park trees and outlines enabled |
| High | 0 m (raw OSM footprint vertices) | Within 480 m; retained until 720 m | Full preview detail |

At most 18 refined chunks are resident. When the cap is reached, a newly
requested closer chunk can replace the farthest refined chunk. Coarse preview
remains visible while a refined tier is built and swapped in.

The stream radius is camera-distance based: 1.35 × camera-to-target distance,
bounded to 1,000–400,000 m. Frustum checks and per-feature bounds narrow that
area. The larger upper bound is intentional because the initial camera is
positioned outside the map footprint; a small hard maximum can otherwise leave
far city blocks unloaded in the initial overview.

## Resource management

Chunks own their preview meshes and associated GPU resources. Releasing a chunk
removes its coarse/refined meshes and picker references, then disposes geometry,
materials, and textures. Replacing the OSM scene clears the resident set and
raycast references before rebuilding the new spatial index.

Geometry/material merge failures retain the original geometry batch as a safe
visual fallback. Temporary chunk build failures are cleaned up and retried with
backoff.

## Validation

Run:

```bash
npm run check:preview-lod
pytest -q
```

The pure LOD policy checks cover chunk-size selection, simplification tiers,
hysteresis boundaries, stream-radius bounds, frustum/near-field admission, and
unload decisions. Backend tests ensure the server-side simulation code remains
unchanged. A production Vite build and actual browser FPS measurements must still
be completed in the user's Colab/browser runtime where frontend dependencies and
WebGL are available.


## User runtime status (2026-10-31)

The user reports that this progressive preview/LOD build launches in their
existing Google Colab workflow, does not crash, and the previously used
application interactions still appear to work. A full-city / very-large OSM
selection has **not** yet been loaded or validated due to the user's available
test time. Therefore city-scale scalability, actual browser FPS under a
large-city load, and GPU-memory behaviour remain unverified; they are not
claimed as passed.
