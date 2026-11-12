# Phase 3 — Persistent Scene Manager

## Scope

Phase 3 adds a backend-owned lifecycle for imported Mitsuba scene archives. It
builds on the safe staging and canonical GLB preview from Phase 2/2.1. It does
**not** load the staged scene into Sionna RT and does not alter the active
outdoor scene, TX/RX devices, solver state, or existing outdoor scene builder.

## Session identity and cache

- Every staged scene has a stable `sessionId`.
- `archiveSha256` fingerprints the uploaded ZIP bytes.
- `cacheKey` combines the archive hash with the complete source coordinate
  profile. Identical archive + coordinate profile uploads reuse the existing
  session and GLB preview instead of reparsing every PLY mesh.
- The XML, referenced resources, GLB preview and manifest are stored under the
  configured scene-cache directory. Writes use a temporary directory and an
  atomic directory rename; manifest/state updates use atomic file replacement.
- `SRTS_SCENE_CACHE_DIR` can override the cache location. The default is a
  runtime-local temporary directory.

## Lifecycle

A session can be `staged` or `selected` in the Scene Manager. Selection means
"current staged indoor scene" only. The manifest retains
`activation: not_loaded_into_sionna`; actual Sionna RT activation belongs to a
later phase.

The manager can list, select, clear selection, restore, and delete sessions.
The frontend restores the selected session after a browser refresh and exposes
session history so users do not have to upload the same archive again.

## Resource policy

- Maximum 4 cached sessions.
- Maximum 2 GiB total staged data + preview files.
- 12-hour inactive-session TTL.
- Least-recently-used eviction when limits are exceeded.
- The selected session is protected from eviction until selection is cleared
  or the session is explicitly deleted.

These limits can be tuned in `backend/scene_import.py`.

## Persistence boundary

The manager survives browser refreshes and backend-process restarts as long as
the cache directory remains available. A normal Colab runtime reset deletes
runtime-local temporary storage. To preserve sessions across Colab runtime
resets, configure `SRTS_SCENE_CACHE_DIR` to a mounted persistent location in a
future deployment configuration; Phase 3 does not silently write private scene
archives to Google Drive.

## API

- `GET /api/scene/import/sessions` — session summaries and cache status.
- `GET /api/scene/import/{sessionId}` — full persisted manifest.
- `POST /api/scene/import/{sessionId}/select` — select as current staged scene.
- `DELETE /api/scene/import/selection` — clear selection, retaining sessions.
- `DELETE /api/scene/import/{sessionId}` — delete one staged session.
- `GET /api/scene/import/{sessionId}/preview.glb` — retrieve cached preview.

## Validation

The backend tests cover duplicate-import reuse, cache identity including the
coordinate profile, single-selection semantics, disk rehydration after clearing
in-memory state, deletion, and LRU eviction. The frontend contract check is
registered as `npm run check:scene-manager`, which the ZIP-only Colab launcher
picks up automatically from `package.json`.

## Explicit non-goals

- No `mi.load_file()` or `sionna.rt.load_scene()` activation.
- No Sionna radio-material registration or per-object RF material assignment.
- No solver dispatch changes.
- No TX/RX placement or viewport integration.
- No outdoor `build_scene()` changes.
