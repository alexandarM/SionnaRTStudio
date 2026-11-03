# Radio-map completion fix

Date: 2026-10-31

## User-observed symptom

The user reports that clicking the coverage-map action never produces a map.
A previous attempt ended at the frontend's `RequestTimeoutError` after 600 s;
other attempts remained in the `Computing Propagation Matrix...` state. The
user also reports that direct Sionna RT notebook execution on comparable
inputs normally finishes within minutes. The 600 s deadline is configured in
`src/api.ts` as `SOLVE_TIMEOUT_MS = 10 * 60_000`; it wraps both `fetch()` and
`response.json()`, so the timeout alone does not identify the stage.

## Confirmed source-code bottleneck

`backend/solver.py::solve_radiomap()` called `RadioMapSolver`, transferred its
cell centers/RSS/SINR to NumPy, and then performed a second LOS approximation
for every returned cell. For each cell it called
`_segment_has_building_los()`. That helper iterated over **all** building
footprints and rebuilt a Shapely `Polygon` for each building before testing
intersection with the Tx-to-cell line. This made the CPU post-processing
complexity O(number of map cells × number of buildings), in addition to the
actual Sionna solve.

For a nominal 2 km × 2 km scene, the current solver bounds add 60 m to each
side (about 2,060 m × 2,060 m). The approximate grid sizes are therefore:

| Cell step | Approximate cells |
|---:|---:|
| 8 m | 66,564 |
| 4 m | 265,225 |

With thousands of buildings, the old post-processing could rebuild tens to
hundreds of millions of polygons. This is a strong code-level explanation for
why the UI could appear never to finish after Sionna's actual RadioMapSolver
work. It is not a measured claim about the user's specific GPU runtime.

## Implementation

1. Removed per-cell `_segment_has_building_los()` work from the critical
   radio-map response path.
2. Changed `RadioMapCell.isLos` to an optional value. `None` means unknown,
   because Sionna `RadioMapSolver` returns path gain/RSS/SINR but does not
   provide a per-cell LOS flag.
3. Updated the synthetic coverage-channel export to emit `los_status: null`
   when LOS is unknown, instead of incorrectly labelling every unknown cell
   as NLOS. Its metadata explicitly documents the unknown LOS source.
4. Added stage timing logs around scene construction, RadioMapSolver,
   GPU-to-CPU transfer, NumPy/Pydantic post-processing, backend solve-lock
   wait, handler completion, and API response serialization. These logs make
   it possible to localize a future timeout rather than guessing.
5. Kept all physical RadioMapSolver controls untouched: frequency, TX power,
   antenna array/pattern/polarization, radio materials, max depth, interaction
   flags, samples per Tx, seed, measurement height, and cell size.

## How to interpret the new Colab logs

- No `[radiomap] START`: request did not enter `solve_radiomap` (frontend/API
  routing, JSON validation, server state, or request transfer).
- `[radiomap] START` but no `scene_ready`: scene construction/cache is the
  current bottleneck.
- `scene_ready` but no `solver_returned`: time is being spent inside
  `RadioMapSolver` (GPU/CPU execution, device state, or Sionna scene).
- `solver_returned` but no `gpu_to_cpu_complete`: Dr.Jit evaluation or device-to-host
  transfer is the current bottleneck.
- `gpu_to_cpu_complete` but no `response_ready`: CPU post-processing or response
  model construction is the current bottleneck.
- `handler_complete` but no `response_ready`: FastAPI response validation/JSON
  serialization is the current bottleneck.
- `response_ready` appears quickly but the browser times out: response transfer
  or browser-side JSON parsing/rendering is implicated.

## Validation and limitations

- Backend unit tests: 97 passed.
- Python `compileall`: passed.
- Shell syntax checks: passed.
- The pure-Python test validates nullable/legacy LOS semantics.
- A full Vite build was not run because npm dependencies were not available in
  the offline package cache.
- This execution environment does not have Mitsuba or Sionna RT installed
  and does not expose the user's Colab GPU; therefore a live RadioMapSolver
  run and before/after radio-map wall-time measurement were not possible.
- The city-scale preview build is reported by the user to launch and not crash,
  but loading a whole-city scene has not yet been tested.

## Source references

- `src/api.ts`: 10-minute solve request budget.
- `src/components/CoveragePanel.tsx`: grid cell step and samples-per-Tx controls.
- `src/App.tsx::handleRunHeatmap`: passes all buildings, transmitters and
  coverage options to the API.
- `backend/main.py::api_radiomap`: serialized solver lock and request timing.
- `backend/solver.py::solve_radiomap`: actual `RadioMapSolver` execution and
  post-processing stage timings.
- `backend/models.py::RadioMapCell`: nullable LOS semantics.
- `src/utils.ts::exportCoverageChannelGrid`: unknown LOS exported as null.
