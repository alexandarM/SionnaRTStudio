"""FastAPI app exposing exactly what the React frontend calls.

Core endpoints (camelCase JSON, matching src/types.ts):
  GET  /api/health
  POST /api/solve     {tx, rx, buildings, freqGhz} -> {paths, metrics}
  POST /api/radiomap  {tx, buildings, freqGhz, gridSize, gridHeight} -> RadioMapGrid
  POST /api/mobility  {txs, rx, buildings, waypoints, ...} -> {steps, execution}
  POST /api/cir       link + OFDM grid -> CIR/CFR file
  POST /api/linkkpi   link + OFDM grid -> Shannon-capacity link KPIs
  POST /api/phyber    link + PUSCH config -> BER/BLER sweep job (optional PHY pkg)
  GET  /api/phyber/{jobId}  poll a running sweep -> progress/result
  POST /api/channel-grid  tx + receiver cells + OFDM grid -> ray-traced CFR file
  POST /api/scene-export  buildings + devices -> standalone Sionna RT scene ZIP

Real NVIDIA Sionna RT ray tracing runs here (needs an NVIDIA GPU + CUDA Mitsuba
variant). Solves are serialized with a lock because the Sionna/Mitsuba runtime is
not re-entrant.
"""
# Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
# Upstream: https://github.com/puloktarafder/SionnaRTStudio

from __future__ import annotations

import io
import csv
import importlib.metadata
import json
import logging
import platform
import threading
import time
import zipfile
import uuid

# Homebrew LLVM is keg-only. Configure Dr.Jit before importing Mitsuba so
# direct uvicorn launches work as reliably as setup.sh/run.sh on macOS.
from .runtime_env import configure_drjit_llvm_path

configure_drjit_llvm_path()

import mitsuba as mi
import numpy as np

# Prefer GPU ray tracing. Sionna RT would pick a variant on its own, but pinning
# one here (before sionna is imported) makes that explicit and lets /api/health
# report which device actually traces the rays.
#
# mi.variants() lists what Mitsuba was COMPILED with, not what this host can
# actually run — the published wheels always bundle the CUDA variants. So
# membership alone is not enough: set_variant() is the call that initializes
# CUDA, and it raises on any machine without a usable GPU (a VM with no
# passthrough, a box with no NVIDIA card, a driver/library mismatch). Falling
# through to a CPU variant keeps the backend serving instead of killing the
# whole process at import time.
# Only the `_ad_` variants carry the autodiff + vectorized types Sionna's solvers
# need; the `scalar_*` ones are deliberately NOT candidates. Mitsuba will happily
# select a scalar variant, but every solve then dies deep inside Sionna with
# "epsilon(): input is not a Dr.Jit array" — a backend that answers /api/health
# and fails every actual request is worse than one that refuses to start.
logger = logging.getLogger(__name__)

_GPU_VARIANT = "cuda_ad_mono_polarized"
_CPU_VARIANT = "llvm_ad_mono_polarized"

_failures: list[str] = []
for _candidate in (_GPU_VARIANT, _CPU_VARIANT):
    if _candidate not in mi.variants():
        _failures.append(f"{_candidate}: not compiled into this Mitsuba build")
        continue
    try:
        mi.set_variant(_candidate)
        break
    except Exception as exc:  # noqa: BLE001 — any init failure means "try the next one"
        _failures.append(f"{_candidate}: {str(exc).strip().splitlines()[0]}")
        logger.warning("Mitsuba variant %r is unavailable; trying the next runtime variant", _candidate)
else:
    if platform.system() == "Darwin":
        _llvm_help = (
            "On Apple Silicon, install Homebrew LLVM with: brew install llvm\n"
            "SionnaRTStudio auto-discovers its keg-only libLLVM.dylib; re-run "
            "./setup.sh if it is still unavailable."
        )
    else:
        _llvm_help = (
            "With no NVIDIA GPU, the CPU path needs the LLVM runtime:\n"
            "  sudo apt install llvm-runtime\n"
            "or point Dr.Jit at an existing one with DRJIT_LIBLLVM_PATH."
        )
    raise RuntimeError(
        "No usable Mitsuba variant — cannot ray-trace on this machine.\n"
        + "\n".join(f"  - {f}" for f in _failures)
        + "\n\n"
        + _llvm_help
    )

if not (mi.variant() or "").startswith("cuda"):
    logger.warning(
        "No CUDA GPU is available; ray tracing will use the CPU variant %r. "
        "Solves will be significantly slower.",
        mi.variant(),
    )

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from .linklevel import compute_link_kpis
from .linkphy import phy_available, run_pusch_ber_sweep
from .nr_config import build_sweep_points
from .models import (
    CIRRequest,
    ChannelAnalysisRequest,
    ChannelGridRequest,
    LinkKpiRequest,
    LinkKpiResponse,
    MobilityRequest,
    MobilityResponse,
    MeasurementGeospatialAuditRequest,
    MeasurementMatchingAuditRequest,
    MeasurementRayTraceRequest,
    OSMQueryRequest,
    PhyBerJobStatus,
    PhyBerRequest,
    PhyBerResult,
    ExperimentCreateRequest,
    ExperimentUpdateRequest,
    ConfigurationPresetCreateRequest,
    MeasurementRayTraceJobStatus,
    RadioMapGrid,
    RadioMapRequest,
    SceneExportRequest,
    SolveRequest,
    SolveResponse,
)
from .osm_proxy import OSMProxyError, fetch_osm_tile
from .measurement_validation import (
    MeasurementImportError,
    export_measurement_csv,
    compute_geospatial_audit,
    export_georeferenced_measurement_csv,
    get_measurement_dataset,
    get_measurement_rows,
    list_measurement_datasets,
    parse_measurement_csv,
    store_measurement_dataset,
)
from .measurement_matching import compute_measurement_matching_audit
from .measurement_simulation import run_measurement_location_raytrace
from .experiment_store import (
    init_experiment_store, create_experiment, update_experiment, list_experiments,
    delete_experiment, create_preset, list_presets, delete_preset,
)
from .scene_export import scene_export_zip
from .solver import (
    _notebook_tau_shape,
    solve_channel_grid,
    solve_radio_map_channel_analysis,
    solve_cir,
    solve_link,
    solve_mobility,
    solve_radiomap,
    get_radio_map_tx_data,
    get_radio_map_sector_analysis,
    get_radio_map_interference_matrix,
    get_radio_map_sample_cells,
)

app = FastAPI(title="SionnaRTStudio Backend", version="1.0.0")
init_experiment_store()


@app.middleware("http")
async def radiomap_response_timing(request, call_next):
    """Log the serialized radio-map response stage as distinct from RT solve time."""
    started = time.perf_counter()
    response = await call_next(request)
    if request.url.path == "/api/radiomap":
        length = response.headers.get("content-length", "unknown")
        logger.debug(
            "Radio-map response ready: status=%s content_length=%s total_seconds=%.2f",
            response.status_code, length, time.perf_counter() - started,
        )
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Sionna/Mitsuba is single-threaded; serialize solves.
_solve_lock = threading.Lock()


def _solve_error(exc: Exception, label: str) -> HTTPException:
    """Map a solver failure to an HTTP error.

    ValueError means the request itself was invalid (bad geometry, mismatched
    arrays, cell cap exceeded) → 400. Anything else is a server-side fault
    (GPU/Mitsuba/Sionna runtime) → 500.
    """
    logger.exception("%s", label)
    status = 400 if isinstance(exc, ValueError) else 500
    return HTTPException(status_code=status, detail=f"{label}: {exc}")


@app.get("/api/health")
def health() -> dict:
    variant = mi.variant() or "unset"
    def version(distribution: str) -> str:
        try:
            return importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            return "unknown"

    return {
        "ok": True,
        "app": "SionnaRTStudio",
        "appVersion": "1.0.0",
        "engine": "Sionna RT",
        "solver": "real ray tracing",
        "variant": variant,
        "gpu": variant.startswith("cuda"),
        "pythonVersion": platform.python_version(),
        "sionnaRtVersion": version("sionna-rt"),
        "mitsubaVersion": version("mitsuba"),
        "drjitVersion": version("drjit"),
        # Optional Sionna PHY package (full NR PUSCH BER/BLER chain).
        "phy": phy_available(),
        "sionnaPhyVersion": version("sionna") if phy_available() else None,
    }




# ── Experiment history & RF configuration presets ─────────────────────────

@app.get("/api/experiments")
def api_list_experiments(limit: int = Query(default=200, ge=1, le=1000)) -> dict:
    return {"experiments": list_experiments(limit)}


@app.post("/api/experiments")
def api_create_experiment(req: ExperimentCreateRequest) -> dict:
    try:
        return create_experiment(req.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/api/experiments/{experiment_id}")
def api_update_experiment(experiment_id: str, req: ExperimentUpdateRequest) -> dict:
    try:
        updated = update_experiment(experiment_id, req.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="Unknown experiment")
    return updated


@app.delete("/api/experiments/{experiment_id}")
def api_delete_experiment(experiment_id: str) -> dict:
    if not delete_experiment(experiment_id):
        raise HTTPException(status_code=404, detail="Unknown experiment")
    return {"deleted": True, "id": experiment_id}


@app.get("/api/configuration-presets")
def api_list_configuration_presets() -> dict:
    return {"presets": list_presets()}


@app.post("/api/configuration-presets")
def api_create_configuration_preset(req: ConfigurationPresetCreateRequest) -> dict:
    try:
        return create_preset(req.name, req.description, req.configuration)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/configuration-presets/{preset_id}")
def api_delete_configuration_preset(preset_id: str) -> dict:
    if not delete_preset(preset_id):
        raise HTTPException(status_code=404, detail="Unknown configuration preset")
    return {"deleted": True, "id": preset_id}


@app.post("/api/osm/query")
def api_osm_query(req: OSMQueryRequest) -> dict:
    """Same-origin, server-side Overpass proxy for browser OSM tile requests.

    The backend chooses among published global Overpass instances, adds an
    identifiable User-Agent, serializes outbound calls, and reports typed
    upstream failures to the frontend. Only bounding boxes are accepted.
    """
    try:
        return fetch_osm_tile(req.south, req.west, req.north, req.east)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"message": str(exc), "kind": "fatal"}) from exc
    except OSMProxyError as exc:
        headers = {"Retry-After": str(exc.retry_after_seconds)} if exc.retry_after_seconds else None
        raise HTTPException(
            status_code=exc.status_code,
            detail={"message": exc.message, "kind": exc.kind},
            headers=headers,
        ) from exc

@app.post("/api/measurements/import")
async def api_import_measurements(request: Request, filename: str = Query(default="measurements.csv")) -> dict:
    """Import a Quectel CSV or GPS-joined CSV without mutating the source file.

    The browser sends the CSV as raw UTF-8 text (not multipart), avoiding an
    extra python-multipart dependency in the Colab runtime. Imported datasets
    are held in backend memory and survive tab navigation, but not a backend
    process restart or Colab runtime reset.
    """
    body = await request.body()
    try:
        dataset = parse_measurement_csv(filename, body)
        store_measurement_dataset(dataset)
    except MeasurementImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "datasetId": dataset["datasetId"],
        "filename": dataset["filename"],
        "columns": dataset["columns"],
        "summary": dataset["summary"],
        "preview": dataset["preview"],
    }


@app.get("/api/measurements")
def api_list_measurements() -> dict:
    return {"datasets": list_measurement_datasets()}


@app.get("/api/measurements/{dataset_id}")
def api_get_measurement_dataset(dataset_id: str) -> dict:
    dataset = get_measurement_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset; it may have been cleared by a backend restart.")
    return {
        "datasetId": dataset["datasetId"],
        "filename": dataset["filename"],
        "columns": dataset["columns"],
        "summary": dataset["summary"],
        "preview": dataset["preview"],
    }


@app.get("/api/measurements/{dataset_id}/rows")
def api_get_measurement_rows(
    dataset_id: str,
    rat: str | None = Query(default=None, max_length=32),
    pci: int | None = Query(default=None, ge=0, le=1007),
    valid_only: bool = Query(default=False),
    spatial_only: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    try:
        return get_measurement_rows(
            dataset_id, rat=rat, pci=pci, valid_only=valid_only,
            spatial_only=spatial_only, limit=limit, offset=offset,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset") from exc


@app.post("/api/measurements/{dataset_id}/geospatial-audit")
def api_measurement_geospatial_audit(dataset_id: str, req: MeasurementGeospatialAuditRequest) -> dict:
    try:
        scene_bounds = req.sceneBounds.model_dump() if req.sceneBounds else None
        result = compute_geospatial_audit(
            dataset_id,
            anchor_latitude=req.anchorLatitude,
            anchor_longitude=req.anchorLongitude,
            scene_bounds=scene_bounds,
        )
        # Per-row coordinates are returned only through the CSV export endpoint.
        result.pop("_coordinateRows", None)
        return result
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset") from exc
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/measurements/{dataset_id}/matching-audit")
def api_measurement_matching_audit(dataset_id: str, req: MeasurementMatchingAuditRequest) -> dict:
    """Profile measured RAT/PCI/carrier contexts and rank scene TX candidates.

    This is a review aid only: it never auto-assigns a measured PCI to a site or
    transmitter. The physical association requires operator/user confirmation.
    """
    try:
        scene_bounds = req.sceneBounds.model_dump() if req.sceneBounds else None
        return compute_measurement_matching_audit(
            dataset_id,
            anchor_latitude=req.anchorLatitude,
            anchor_longitude=req.anchorLongitude,
            transmitters=[tx.model_dump() for tx in req.transmitters],
            rat=req.rat,
            profile_id=req.profileId,
            pci=req.pci,
            band=req.band,
            arfcn=req.arfcn,
            scene_bounds=scene_bounds,
            preview_limit=req.previewLimit,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset") from exc
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ── Measurement-location ray-trace background jobs with cooperative cancel ─
_measurement_raytrace_jobs: dict[str, dict] = {}
_measurement_raytrace_jobs_lock = threading.Lock()


def _measurement_raytrace_job_worker(job_id: str, dataset_id: str, req: MeasurementRayTraceRequest) -> None:
    with _measurement_raytrace_jobs_lock:
        job = _measurement_raytrace_jobs[job_id]
        cancel_event = job["cancel_event"]

    def update(progress: float, message: str) -> None:
        with _measurement_raytrace_jobs_lock:
            job["progress"] = max(0.0, min(1.0, float(progress)))
            job["message"] = message

    try:
        update(0.05, "Queued for the Sionna RT solver")
        with _solve_lock:
            if cancel_event.is_set():
                raise InterruptedError("Cancellation requested before PathSolver dispatch")
            result = run_measurement_location_raytrace(
                dataset_id, req, cancel_event=cancel_event, progress=update,
            )
        with _measurement_raytrace_jobs_lock:
            if cancel_event.is_set():
                job.update(status="cancelled", progress=1.0, message="Cancelled; result discarded", result=None)
            else:
                job.update(status="done", progress=1.0, message="Done", result=result)
    except InterruptedError as exc:
        with _measurement_raytrace_jobs_lock:
            job.update(status="cancelled", progress=1.0, message=str(exc) or "Cancelled", result=None)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Measurement-location ray-tracing job failed")
        with _measurement_raytrace_jobs_lock:
            job.update(status="error", progress=1.0, message=f"Measurement ray trace failed: {exc}", result=None)


@app.post("/api/measurements/{dataset_id}/raytrace-jobs", response_model=MeasurementRayTraceJobStatus)
def api_start_measurement_raytrace_job(dataset_id: str, req: MeasurementRayTraceRequest) -> MeasurementRayTraceJobStatus:
    if get_measurement_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset")
    job_id = f"mrt_{uuid.uuid4().hex[:16]}"
    with _measurement_raytrace_jobs_lock:
        _measurement_raytrace_jobs[job_id] = {
            "status": "running", "progress": 0.0, "message": "Queued", "result": None,
            "cancel_event": threading.Event(),
        }
    threading.Thread(
        target=_measurement_raytrace_job_worker, args=(job_id, dataset_id, req), daemon=True,
    ).start()
    return MeasurementRayTraceJobStatus(jobId=job_id, status="running", progress=0.0, message="Queued")


@app.get("/api/measurement-raytrace-jobs/{job_id}", response_model=MeasurementRayTraceJobStatus)
def api_measurement_raytrace_job_status(job_id: str) -> MeasurementRayTraceJobStatus:
    with _measurement_raytrace_jobs_lock:
        job = _measurement_raytrace_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown measurement ray-trace job {job_id}")
        snapshot = {key: job[key] for key in ("status", "progress", "message", "result")}
    return MeasurementRayTraceJobStatus(jobId=job_id, **snapshot)


@app.delete("/api/measurement-raytrace-jobs/{job_id}", response_model=MeasurementRayTraceJobStatus)
def api_cancel_measurement_raytrace_job(job_id: str) -> MeasurementRayTraceJobStatus:
    with _measurement_raytrace_jobs_lock:
        job = _measurement_raytrace_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown measurement ray-trace job {job_id}")
        if job["status"] == "running":
            job["cancel_event"].set()
            job["status"] = "cancelling"
            job["message"] = "Cancellation requested; current GPU PathSolver dispatch must return first"
        snapshot = {key: job[key] for key in ("status", "progress", "message", "result")}
    return MeasurementRayTraceJobStatus(jobId=job_id, **snapshot)


@app.post("/api/measurements/{dataset_id}/raytrace-samples")
def api_measurement_raytrace_samples(dataset_id: str, req: MeasurementRayTraceRequest) -> dict:
    """Ray-trace a selected scene TX to a bounded sample of field GPS positions.

    The operation is serialized with all other Mitsuba/Sionna solves. It reports
    Sionna total received power separately from measured modem SS-RSRP.
    """
    try:
        with _solve_lock:
            return run_measurement_location_raytrace(dataset_id, req)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise _solve_error(exc, "Measurement-location ray trace failed") from exc


@app.post("/api/measurements/{dataset_id}/georeferenced.csv")
def api_export_georeferenced_measurements(dataset_id: str, req: MeasurementGeospatialAuditRequest):
    try:
        scene_bounds = req.sceneBounds.model_dump() if req.sceneBounds else None
        content = export_georeferenced_measurement_csv(
            dataset_id,
            anchor_latitude=req.anchorLatitude,
            anchor_longitude=req.anchorLongitude,
            scene_bounds=scene_bounds,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset") from exc
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="measurements_{dataset_id[:8]}_georeferenced.csv"'},
    )


@app.get("/api/measurements/{dataset_id}/export.csv")
def api_export_measurements(dataset_id: str, spatial_only: bool = Query(default=False)):
    try:
        content = export_measurement_csv(dataset_id, spatial_only=spatial_only)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown measurement dataset") from exc
    safe_name = dataset_id[:8]
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="measurements_{safe_name}_qc.csv"'},
    )


@app.post("/api/solve", response_model=SolveResponse)
def api_solve(req: SolveRequest) -> SolveResponse:
    try:
        with _solve_lock:
            paths, metrics = solve_link(req)
        return SolveResponse(paths=paths, metrics=metrics)
    except Exception as exc:  # surface a clean error to the UI
        raise _solve_error(exc, "Link solve failed") from exc


@app.post("/api/radiomap", response_model=RadioMapGrid)
def api_radiomap(req: RadioMapRequest) -> RadioMapGrid:
    request_started = time.perf_counter()
    lock_started = request_started
    try:
        with _solve_lock:
            lock_wait = time.perf_counter() - lock_started
            solve_started = time.perf_counter()
            logger.debug("Radio-map solver lock acquired after %.2f seconds", lock_wait)
            result = solve_radiomap(req)
            logger.debug(
                "Radio-map handler complete: solve_seconds=%.2f request_seconds=%.2f",
                time.perf_counter() - solve_started,
                time.perf_counter() - request_started,
            )
            return result
    except Exception as exc:
        logger.exception("Radio-map request failed after %.2f seconds", time.perf_counter() - request_started)
        raise _solve_error(exc, "Radio map failed") from exc


@app.get("/api/radiomap/{map_id}/tx/{tx_index}/export.csv")
def api_radiomap_tx_export(map_id: str, tx_index: int):
    """Export one transmitter's native Sionna radio-map layers as CSV.

    The cached values are path gain (linear), RSS (W), and SINR (linear).
    Their dB/dBm conversions are included as convenience columns.
    """
    try:
        data = get_radio_map_tx_data(map_id, tx_index)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    def rows():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "x_enu_m", "y_enu_m", "z_enu_m", "path_gain_linear", "path_gain_db",
            "rss_w", "rss_dbm", "sinr_linear", "sinr_db",
            "interference_power_dbm", "sir_db", "inr_db",
            "is_best_rss_server", "is_best_sinr_tx", "is_best_path_gain_tx",
            "top_interferer_tx", "top_interferer_power_dbm", "top_interference_share_percent",
        ])
        yield output.getvalue()
        output.seek(0); output.truncate(0)
        import numpy as np
        from .radio_analysis import watts_to_dbm, linear_to_db
        centers = data["centers"]
        pg = data["pathGain"]
        rss = data["rss"]
        sinr = data["sinr"]
        pg_db = linear_to_db(pg)
        rss_dbm = watts_to_dbm(rss)
        sinr_db = linear_to_db(sinr)
        rss_all_clean = np.where(np.isfinite(data["rssAll"]) & (data["rssAll"] > 0.0), data["rssAll"], 0.0)
        rss_clean = np.where(np.isfinite(rss) & (rss > 0.0), rss, 0.0)
        interference_w = np.maximum(np.sum(rss_all_clean, axis=0) - rss_clean, 0.0)
        best_idx = np.asarray(data["bestRssTx"], dtype=np.int32) if data.get("bestRssTx") is not None else np.argmax(rss_all_clean, axis=0)
        cell_indices = np.arange(len(rss_clean))
        other = rss_all_clean.copy()
        safe_best_idx = np.where(best_idx >= 0, best_idx, 0)
        other[safe_best_idx, cell_indices] = 0.0
        top_interferer_idx = np.argmax(other, axis=0)
        top_interferer_w = other[top_interferer_idx, cell_indices]
        top_interferer_idx = np.where(top_interferer_w > 0.0, top_interferer_idx, -1)
        top_share_percent = np.where(interference_w > 0.0, 100.0 * top_interferer_w / interference_w, 0.0)
        top_interferer_dbm = watts_to_dbm(top_interferer_w)
        interference_dbm = watts_to_dbm(interference_w)
        with np.errstate(divide="ignore", invalid="ignore"):
            sir_db = linear_to_db(rss / np.maximum(interference_w, 1e-300))
            inr_db = linear_to_db(interference_w / max(data["noisePowerW"], 1e-300))
        no_interference = interference_w <= 0
        interference_dbm[no_interference] = -300.0
        sir_db[no_interference & (rss_clean > 0.0)] = 300.0
        sir_db[no_interference & (rss_clean <= 0.0)] = np.nan
        inr_db[no_interference] = -300.0
        for i in range(len(centers)):
            writer.writerow([
                float(centers[i, 0]), float(centers[i, 1]), float(centers[i, 2]),
                float(pg[i]) if np.isfinite(pg[i]) else "",
                float(pg_db[i]) if np.isfinite(pg_db[i]) else "",
                float(rss[i]) if np.isfinite(rss[i]) else "",
                float(rss_dbm[i]) if np.isfinite(rss_dbm[i]) else "",
                float(sinr[i]) if np.isfinite(sinr[i]) else "",
                float(sinr_db[i]) if np.isfinite(sinr_db[i]) else "",
                float(interference_dbm[i]) if np.isfinite(interference_dbm[i]) else "",
                float(sir_db[i]) if np.isfinite(sir_db[i]) else "",
                float(inr_db[i]) if np.isfinite(inr_db[i]) else "",
                bool(data["bestRssTx"][i] == tx_index) if data.get("bestRssTx") is not None else "",
                bool(data["bestSinrTx"][i] == tx_index) if data.get("bestSinrTx") is not None else "",
                bool(data["bestPathGainTx"][i] == tx_index) if data.get("bestPathGainTx") is not None else "",
                int(top_interferer_idx[i]) if top_interferer_idx[i] >= 0 else "",
                float(top_interferer_dbm[i]) if np.isfinite(top_interferer_dbm[i]) else "",
                float(top_share_percent[i]),
            ])
            if i % 2048 == 2047:
                yield output.getvalue()
                output.seek(0); output.truncate(0)
        if output.tell():
            yield output.getvalue()

    safe_name = str(data["metadata"].get("txName", f"tx_{tx_index}")).replace("/", "_").replace("\\", "_")
    return StreamingResponse(
        rows(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="radiomap_{safe_name}.csv"'},
    )


@app.get("/api/radiomap/{map_id}/sector/{tx_index}/analysis")
def api_radiomap_sector_analysis(map_id: str, tx_index: int):
    """Compute the detailed Sector Inspector payload from cached radio-map layers."""
    try:
        return get_radio_map_sector_analysis(map_id, tx_index)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/radiomap/{map_id}/interference-matrix")
def api_radiomap_interference_matrix(
    map_id: str,
    top_k: int = Query(default=3, ge=1, le=5),
):
    """Return top-K dominant interferer pairs per RSS-serving sector."""
    try:
        return get_radio_map_interference_matrix(map_id, top_k=top_k)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/radiomap/{map_id}/sector/{tx_index}/samples")
def api_radiomap_sector_sample_candidates(
    map_id: str,
    tx_index: int,
    criterion: str = Query(default="weak_sinr", pattern="^(weak_sinr|weak_rss|strong_interference)$"),
    limit: int = Query(default=16, ge=1, le=60),
    association_scope: str = Query(default="all", pattern="^(all|rss_serving|sinr_serving)$"),
    selection_mode: str = Query(default="spatially_distributed", pattern="^(strict_topk|spatially_distributed)$"),
):
    """Return candidate map-cell locations as JSON for interactive PathSolver selection."""
    try:
        return get_radio_map_sample_cells(
            map_id, tx_index, criterion=criterion, limit=limit,
            association_scope=association_scope, selection_mode=selection_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/radiomap/{map_id}/sector/{tx_index}/samples.csv")
def api_radiomap_sector_samples(
    map_id: str,
    tx_index: int,
    criterion: str = Query(default="weak_sinr", pattern="^(weak_sinr|weak_rss|strong_interference)$"),
    limit: int = Query(default=200, ge=1, le=2000),
    association_scope: str = Query(default="all", pattern="^(all|rss_serving|sinr_serving)$"),
    selection_mode: str = Query(default="spatially_distributed", pattern="^(strict_topk|spatially_distributed)$"),
):
    """Export deterministic weak-signal / weak-SINR / high-interference map cells."""
    try:
        rows_data = get_radio_map_sample_cells(
            map_id, tx_index, criterion=criterion, limit=limit,
            association_scope=association_scope, selection_mode=selection_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    def rows():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["cell_index", "x_enu_m", "y_enu_m", "z_enu_m", "rss_dbm", "sinr_db", "snr_db", "interference_dbm", "association_scope", "selection_mode"])
        for item in rows_data:
            writer.writerow([
                item["cellIndex"], item["x"], item["y"], item["z"],
                item["rssDbm"] if item["rssDbm"] is not None else "",
                item["sinrDb"] if item["sinrDb"] is not None else "",
                item["snrDb"] if item["snrDb"] is not None else "",
                item["interferenceDbm"] if item["interferenceDbm"] is not None else "",
                item["associationScope"], item["selectionMode"],
            ])
        yield output.getvalue()

    return StreamingResponse(
        rows(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="radiomap_tx{tx_index}_{criterion}_samples.csv"'},
    )


@app.post("/api/radiomap/{map_id}/channel-analysis")
def api_radiomap_channel_analysis(map_id: str, req: ChannelAnalysisRequest) -> dict:
    """Run a bounded, one-dispatch PathSolver analysis at selected map cells."""
    try:
        with _solve_lock:
            return solve_radio_map_channel_analysis(map_id, req)
    except Exception as exc:
        raise _solve_error(exc, "Radio-map channel analysis failed") from exc


@app.post("/api/mobility", response_model=MobilityResponse)
def api_mobility(req: MobilityRequest) -> MobilityResponse:
    try:
        with _solve_lock:
            started = time.perf_counter()
            steps, execution, handover = solve_mobility(req)
            execution["solveTimeMs"] = (time.perf_counter() - started) * 1000.0
        return MobilityResponse(steps=steps, execution=execution, handover=handover)
    except Exception as exc:
        raise _solve_error(exc, "Mobility solve failed") from exc


# ── PHY BER/BLER background job (Tier 2) ────────────────────────────────────
# One job at a time: the sweep is CPU-bound for minutes and the UI polls it.
_phy_jobs: dict[str, dict] = {}
_phy_jobs_lock = threading.Lock()


def _phy_job_worker(job_id: str, req: PhyBerRequest) -> None:
    with _phy_jobs_lock:
        job = _phy_jobs[job_id]
        cancel_event = job["cancel_event"]

    def set_progress(fraction: float, message: str) -> None:
        if cancel_event.is_set():
            raise InterruptedError("Cancellation requested")
        with _phy_jobs_lock:
            job["progress"] = float(fraction)
            job["message"] = message

    try:
        set_progress(0.0, "Ray tracing the link (GPU)")
        with _solve_lock:  # RT solve only; the CPU sweep runs unlocked
            if cancel_event.is_set():
                raise InterruptedError("Cancelled before ray tracing")
            cir = solve_cir(req)
        if cancel_event.is_set():
            raise InterruptedError("Cancelled after ray tracing; PHY sweep not started")
        snr_points = build_sweep_points(req.snrMinDb, req.snrMaxDb, req.snrStepDb)
        result = run_pusch_ber_sweep(
            cir,
            mcs_index=req.mcsIndex,
            num_prb=req.numPrb,
            snr_points_db=snr_points,
            slots_per_point=req.slotsPerPoint,
            seed=req.seed,
            mcs_table=req.mcsTable,
            n_cell_id=req.nCellId,
            cyclic_prefix=req.cyclicPrefix,
            dmrs_config_type=req.dmrsConfigType,
            dmrs_additional_position=req.dmrsAdditionalPosition,
            channel_bandwidth_mhz=req.channelBandwidthMHz,
            channel_mode=req.channelMode,
            ue_tx_power_dbm=req.ueTxPowerDbm,
            receiver_noise_figure_db=req.receiverNoiseFigureDb,
            progress=set_progress,
        )
        with _phy_jobs_lock:
            if cancel_event.is_set():
                job.update(status="cancelled", progress=1.0, message="Cancelled; partial sweep result discarded")
            else:
                job["result"] = result
                job["status"] = "done"
                job["progress"] = 1.0
                job["message"] = "Done"
    except InterruptedError as exc:
        with _phy_jobs_lock:
            job.update(status="cancelled", progress=1.0, message=str(exc) or "Cancelled")
    except Exception as exc:  # noqa: BLE001
        logger.exception("NR PHY sweep job failed")
        with _phy_jobs_lock:
            if cancel_event.is_set():
                job.update(status="cancelled", progress=1.0, message="Cancelled")
            else:
                job["status"] = "error"
                job["message"] = f"PHY sweep failed: {exc}"


@app.post("/api/phyber", response_model=PhyBerJobStatus)
def api_phyber_start(req: PhyBerRequest) -> PhyBerJobStatus:
    """Start a BER/BLER-vs-Eb/N0 sweep of the active link (background job)."""
    if not phy_available():
        raise HTTPException(
            status_code=400,
            detail="Sionna PHY is not installed — "
                   "pip install -r backend/requirements-phy.txt",
        )
    with _phy_jobs_lock:
        if any(j["status"] in {"running", "cancelling"} for j in _phy_jobs.values()):
            raise HTTPException(status_code=409, detail="A PHY sweep is already running")
        job_id = f"phy_{uuid.uuid4().hex[:16]}"
        _phy_jobs[job_id] = {"status": "running", "progress": 0.0,
                             "message": "Queued", "result": None, "cancel_event": threading.Event()}
    threading.Thread(target=_phy_job_worker, args=(job_id, req), daemon=True).start()
    return PhyBerJobStatus(jobId=job_id, status="running", progress=0.0, message="Queued")


@app.get("/api/phyber/{job_id}", response_model=PhyBerJobStatus)
async def api_phyber_status(job_id: str) -> PhyBerJobStatus:
    # This endpoint only reads a small in-memory status record. Keep it async
    # so CPU-heavy PUSCH work cannot starve the FastAPI worker threadpool and
    # cause the frontend's polling request to time out.
    with _phy_jobs_lock:
        job = _phy_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown PHY job {job_id}")
        snapshot = {
            "status": job["status"],
            "progress": job["progress"],
            "message": job["message"],
            "result": job["result"],
        }
    result = PhyBerResult(**snapshot["result"]) if snapshot["result"] else None
    return PhyBerJobStatus(jobId=job_id, status=snapshot["status"],
                           progress=snapshot["progress"], message=snapshot["message"],
                           result=result)


@app.delete("/api/phyber/{job_id}", response_model=PhyBerJobStatus)
def api_phyber_cancel(job_id: str) -> PhyBerJobStatus:
    with _phy_jobs_lock:
        job = _phy_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown PHY job {job_id}")
        if job["status"] == "running":
            job["cancel_event"].set()
            job["status"] = "cancelling"
            job["message"] = "Cancellation requested; current GPU/CPU stage will stop at its next safe checkpoint"
        result = PhyBerResult(**job["result"]) if job.get("result") else None
        return PhyBerJobStatus(jobId=job_id, status=job["status"], progress=job["progress"], message=job["message"], result=result)


@app.post("/api/linkkpi", response_model=LinkKpiResponse)
def api_linkkpi(req: LinkKpiRequest) -> LinkKpiResponse:
    """Shannon-capacity KPIs for one link from its ray-traced CFR (Tier 1 —
    pure NumPy on the solve_cir output, no PHY package)."""
    try:
        with _solve_lock:
            data = solve_cir(req)
        # KPI reduction is plain NumPy — no GPU/Mitsuba, so run outside the lock.
        kpis = compute_link_kpis(
            data["h"], data["frequencies"], data["num_tx_ant"],
            tx_power_dbm=req.tx.powerDbm,
            subcarrier_spacing=req.subcarrierSpacing,
            num_subcarriers=data["num_subcarriers"],
            noise_figure_db=req.noiseFigureDb,
            snr_override_db=req.snrOverrideDb,
        )
        return LinkKpiResponse(**kpis)
    except Exception as exc:
        raise _solve_error(exc, "Link KPI solve failed") from exc


def _cir_npz_metadata(d: dict) -> dict:
    """Device/array metadata shared by raw-CIR and combined CIR/CFR files."""
    return {
        "carrier_frequency": np.asarray(d["carrier_frequency"]),
        "tx_array": d["tx_array"],                 # [horizontal, vertical]
        "rx_array": d["rx_array"],                 # [horizontal, vertical]
        "num_tx": np.asarray(d["num_tx"]),
        "num_rx": np.asarray(d["num_rx"]),
        "num_tx_ant": np.asarray(d["num_tx_ant"]), # polarization-aware port count
        "num_rx_ant": np.asarray(d["num_rx_ant"]),
        "tx_ids": d["tx_ids"],                     # tensor axis index -> device
        "rx_ids": d["rx_ids"],
        "tx_names": d["tx_names"],
        "rx_names": d["rx_names"],
        "tx_positions": d["tx_positions"],         # ENU [m], effective height
        "rx_positions": d["rx_positions"],
        "synthetic_array": np.asarray(True),
    }


def _cir_npz(d: dict) -> bytes:
    """Pack full-fidelity CIR/CFR arrays into NumPy ``.npz``."""
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        a=d["a"],                              # complex CIR coefficients
        tau=_notebook_tau_shape(d["a"], d["tau"]), # tutorial-compatible delays
        tau_geometric=d["tau"],                # native synthetic-array delays
        h_freq=d["h"],                         # complex CFR
        frequencies=d["frequencies"],          # baseband subcarrier offsets [Hz]
        subcarrier_spacing=np.asarray(d["subcarrier_spacing"]),
        **_cir_npz_metadata(d),
    )
    return buf.getvalue()


def _raw_cir_npz(d: dict) -> bytes:
    """Pack exactly ``a, tau = paths.cir(...)`` plus device-axis metadata."""
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        a=d["a"],
        tau=_notebook_tau_shape(d["a"], d["tau"]),
        tau_geometric=d["tau"],
        **_cir_npz_metadata(d),
    )
    return buf.getvalue()


def _safe_bundle_name(value: str) -> str:
    """Filesystem-safe device label for a ZIP member name."""
    cleaned = "".join(
        character if character.isalnum() or character in "-_" else "_"
        for character in value
    ).strip("_")
    return cleaned or "device"


def _cir_bundle_zip(req: CIRRequest) -> bytes:
    """Retrace heterogeneous Tx×Rx pairs and package native CIR NPZ files."""
    txs = req.transmitters()
    rxs = req.receivers()
    manifest = {
        "format": "SionnaRTStudio heterogeneous CIR bundle",
        "schemaVersion": 1,
        "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "carrierFrequencyGhz": req.freqGhz,
        "maxDepth": req.maxDepth,
        "normalizeDelays": req.normalizeDelays,
        "solverOptions": req.options.model_dump(),
        "materials": [material.model_dump() for material in req.materials],
        "tensorLayout": {
            "a": ["num_rx=1", "num_rx_ant", "num_tx=1", "num_tx_ant",
                  "num_paths", "num_time_steps=1"],
            "tau": ["num_rx=1", "num_rx_ant", "num_tx=1", "num_tx_ant",
                    "num_paths"],
        },
        "transmitterCount": len(txs),
        "receiverCount": len(rxs),
        "pairCount": len(txs) * len(rxs),
        "pairs": [],
    }

    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_STORED) as archive:
        for rx_index, rx in enumerate(rxs):
            for tx_index, tx in enumerate(txs):
                pair_req = req.model_copy(update={
                    "tx": tx,
                    "rx": rx,
                    "txs": None,
                    "rxs": None,
                    "format": "cir_npz",
                })
                data = solve_cir(pair_req)
                member = (
                    f"cir/rx_{rx_index:03d}_{_safe_bundle_name(rx.id)}"
                    f"__tx_{tx_index:03d}_{_safe_bundle_name(tx.id)}.npz"
                )
                archive.writestr(member, _raw_cir_npz(data))
                manifest["pairs"].append({
                    "file": member,
                    "rxIndex": rx_index,
                    "rxId": rx.id,
                    "rxName": rx.name,
                    "rxArray": list(rx.antennaArraySize),
                    "numRxAnt": data["num_rx_ant"],
                    "rxPosition": data["rx_positions"][0].tolist(),
                    "txIndex": tx_index,
                    "txId": tx.id,
                    "txName": tx.name,
                    "txArray": list(tx.antennaArraySize),
                    "numTxAnt": data["num_tx_ant"],
                    "txPosition": data["tx_positions"][0].tolist(),
                    "numPaths": data["num_paths"],
                    "aShape": list(data["a"].shape),
                    "tauShape": list(_notebook_tau_shape(
                        data["a"], data["tau"]
                    ).shape),
                })
        archive.writestr(
            "manifest.json",
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        )
    return output.getvalue()


def _cir_csv(d: dict) -> bytes:
    """Per-path CIR table (first antenna pair / first time step)."""
    a = d["a"]
    num_paths = int(d["num_paths"])
    # a shape: [num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths, num_time_steps]
    a0 = a[..., 0] if a.ndim >= 6 else a            # drop the time axis
    flat = a0.reshape(-1, num_paths) if num_paths else a0.reshape(1, 0)
    rep = flat[0] if flat.shape[0] else np.zeros(num_paths, dtype=complex)
    power = (np.abs(flat) ** 2).sum(axis=0)          # combined over antenna pairs
    tau = np.asarray(d["tau"]).reshape(-1, num_paths)[0] if num_paths else np.zeros(0)

    lines = [
        "# Channel impulse response (CIR) — paths.cir(); first antenna pair shown,",
        "# Magnitude/Magnitude_dB combine power over all antenna pairs.",
        f"# carrier_frequency_hz={d['carrier_frequency']:.6e}",
        "Path_Index,Delay_ns,a_real,a_imag,Magnitude,Magnitude_dB,Phase_rad",
    ]
    for i in range(num_paths):
        mag = float(np.sqrt(power[i]))
        mdb = 20.0 * np.log10(mag) if mag > 0 else -np.inf
        lines.append(
            f"{i},{tau[i] * 1e9:.6f},{rep[i].real:.6e},{rep[i].imag:.6e},"
            f"{mag:.6e},{mdb:.3f},{np.angle(rep[i]):.6f}"
        )
    return ("\n".join(lines) + "\n").encode()


def _cfr_csv(d: dict) -> bytes:
    """CFR magnitude/phase per subcarrier (first antenna pair / first time step)."""
    h = d["h"]
    freqs = np.asarray(d["frequencies"]).reshape(-1)
    nf = h.shape[-1]
    h0 = h.reshape(-1, nf)[0] if h.size else np.zeros(nf, dtype=complex)
    carrier = float(d["carrier_frequency"])

    lines = [
        "# Channel frequency response (CFR) — paths.cfr(); first antenna pair shown.",
        f"# carrier_frequency_hz={carrier:.6e}",
        "Subcarrier_Index,Frequency_Offset_Hz,Absolute_Frequency_Hz,h_real,h_imag,Magnitude,Magnitude_dB,Phase_rad",
    ]
    for k in range(nf):
        val = h0[k]
        mag = float(np.abs(val))
        mdb = 20.0 * np.log10(mag) if mag > 0 else -np.inf
        f_off = float(freqs[k]) if k < freqs.size else 0.0
        lines.append(
            f"{k},{f_off:.3f},{carrier + f_off:.3f},{val.real:.6e},{val.imag:.6e},"
            f"{mag:.6e},{mdb:.3f},{np.angle(val):.6f}"
        )
    return ("\n".join(lines) + "\n").encode()


def _channel_grid_npz(d: dict) -> bytes:
    """Pack the per-cell ray-traced channel grid into a NumPy ``.npz``.

    Load with ``np.load(path)``; the channel is ``d['h']`` with layout
    ``[n_cells, n_rx_ant, n_tx_ant, n_subcarrier]``. ``synthetic=False`` marks it
    as a real ray-traced channel (vs the frontend's synthetic JSON export).
    """
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        h=d["h"],                                  # complex per-cell MIMO CFR
        coordinates=d["coordinates"],              # ENU cell centers
        los=d["los"],                              # ray-traced LOS flag
        received_power_dbm=d["received_power_dbm"],
        frequencies=d["frequencies"],              # baseband subcarrier offsets [Hz]
        carrier_frequency=np.asarray(d["carrier_frequency"]),
        subcarrier_spacing=np.asarray(d["subcarrier_spacing"]),
        tx_power_dbm=np.asarray(d["tx_power_dbm"]),
        tx_array=d["tx_array"],                    # [horizontal, vertical]
        rx_array=d["rx_array"],                    # [horizontal, vertical]
        num_tx_ant=np.asarray(d["num_tx_ant"]),
        num_rx_ant=np.asarray(d["num_rx_ant"]),
        h_layout=np.asarray("[n_cells, n_rx_ant, n_tx_ant, n_subcarrier]"),
        synthetic=np.asarray(False),
    )
    return buf.getvalue()


@app.post("/api/channel-grid")
def api_channel_grid(req: ChannelGridRequest) -> Response:
    """Per-cell ray-traced CFR export with physical Tx and Rx array axes."""
    try:
        with _solve_lock:
            data = solve_channel_grid(req)
    except Exception as exc:
        raise _solve_error(exc, "Channel-grid export failed") from exc
    return Response(
        content=_channel_grid_npz(data),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_channel_grid.npz"'},
    )


@app.post("/api/cir")
def api_cir(req: CIRRequest) -> Response:
    """Export native Sionna CIR/CFR tensors for one link or the whole scene."""
    try:
        req.validate_format_scope()
        with _solve_lock:
            data = solve_cir(req)
    except Exception as exc:
        raise _solve_error(exc, "CIR/CFR export failed") from exc

    if req.format == "cir_npz":
        return Response(
            content=_raw_cir_npz(data),
            media_type="application/octet-stream",
            headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cir.npz"'},
        )
    if req.format == "cir_csv":
        return Response(
            content=_cir_csv(data),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cir.csv"'},
        )
    if req.format == "cfr_csv":
        return Response(
            content=_cfr_csv(data),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cfr.csv"'},
        )
    return Response(
        content=_cir_npz(data),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cir_cfr.npz"'},
    )


@app.post("/api/cir-bundle")
def api_cir_bundle(req: CIRRequest) -> Response:
    """Export heterogeneous arrays as one ZIP of exact per-pair CIR tensors."""
    try:
        # Hold the lock for the complete bundle so another request cannot
        # interleave with this deterministic sequence of Sionna solves.
        with _solve_lock:
            content = _cir_bundle_zip(req)
    except Exception as exc:
        raise _solve_error(exc, "CIR bundle export failed") from exc
    return Response(
        content=content,
        media_type="application/zip",
        headers={
            "Content-Disposition":
                'attachment; filename="sionna_rt_studio_cir_all_pairs.zip"'
        },
    )


@app.post("/api/scene-export")
def api_scene_export(req: SceneExportRequest) -> Response:
    """Export the traced scene as a standalone Sionna RT project (ZIP)."""
    try:
        # The scene directory is owned by the build cache, so hold the solver
        # lock while copying it out: that is what stops a concurrent solve from
        # evicting the entry (and deleting the meshes) mid-read.
        with _solve_lock:
            content = scene_export_zip(req)
    except Exception as exc:
        raise _solve_error(exc, "Scene export failed") from exc
    return Response(
        content=content,
        media_type="application/zip",
        headers={
            "Content-Disposition":
                'attachment; filename="sionna_rt_studio_scene.zip"'
        },
    )
