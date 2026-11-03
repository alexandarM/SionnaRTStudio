"""Real Sionna RT solvers mapped onto the frontend's data shapes.

solve_link  -> PropagationPath[] + ChannelMetrics  (PathSolver)
solve_radiomap -> RadioMapGrid                      (RadioMapSolver)

The API and solver share ENU coordinates. The renderer applies only a fixed
ENU-to-Three.js axis permutation/sign change (no geodetic reprojection).
"""
# Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
# Upstream: https://github.com/puloktarafder/SionnaRTStudio

from __future__ import annotations

import logging
import math
import uuid
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np

from .models import (
    BuildingFootprint,
    ChannelMetrics,
    ChannelAnalysisRequest,
    CoverageStats,
    ENUVector,
    PropagationPath,
    RadioMapCell,
    RadioMapGrid,
    RadioMapRequest,
    Receiver,
    SolveRequest,
    SolverOptions,
    Transmitter,
)
from .scene_build import build_scene
from .radio_analysis import (
    compute_radio_map_analytics,
    compute_sector_analysis,
    compute_dominant_interferer_matrix,
    sample_sector_cells,
    METRIC_UNITS,
)

# Sionna InteractionType codes (sionna.rt.constants.InteractionType).
logger = logging.getLogger(__name__)

_INTERACTION_NAMES = {1: "specular", 2: "diffuse", 4: "refraction", 8: "diffraction"}

MAX_PATHS = 15
MAX_DEPTH = 3
# Hard cap on cells for the ray-traced channel-grid export. Cells are solved in
# chunked PathSolver dispatches (chunkSize receivers each), so GPU memory is
# bounded by the chunk — this cap guards total runtime and output size. Keep in
# sync with CHANNEL_GRID_MAX_CELLS in src/components/ExportPanel.tsx.
MAX_CHANNEL_GRID_CELLS = 16384


@dataclass
class _TxSpec:
    """One transmitter resolved for a solve: its scene position, the point its
    beam looks at, its transmit power, and its frontend identity."""
    pos: list[float]
    beam: list[float] | None
    power_dbm: float
    id: str | None = None
    name: str | None = None


def to_numpy(value) -> np.ndarray:
    if isinstance(value, np.ndarray):
        return value
    if np.isscalar(value) or isinstance(value, (list, tuple)):
        return np.asarray(value)
    try:
        import drjit as dr

        return np.asarray(dr.detach(value))
    except Exception:
        if hasattr(value, "numpy"):
            return np.asarray(value.numpy())
        return np.asarray(value)


def _clear_devices(scene) -> None:
    """Remove any transmitters/receivers left on a cached scene from a prior solve.

    Critical: scenes are cached by geometry, so a stale tx from a Link solve would
    otherwise make the radio map see multiple transmitters (path_gain gains a tx
    axis) and break per-cell indexing.
    """
    for attr in ("transmitters", "receivers"):
        try:
            for name in list(getattr(scene, attr).keys()):
                scene.remove(name)
        except Exception:
            pass


def _beam_target(tx_pos, az_deg, el_deg) -> list[float]:
    """A point ~100 m along the steered beam.

    Convention: azimuth degrees clockwise from North (North=0, East=90),
    elevation degrees above the horizon. Matches the 3D beam cone in the UI.
    """
    az = math.radians(float(az_deg or 0.0))
    el = math.radians(float(el_deg or 0.0))
    d = (math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el))
    R = 100.0
    return [float(tx_pos[0] + d[0] * R),
            float(tx_pos[1] + d[1] * R),
            float(tx_pos[2] + d[2] * R)]


def _set_planar_array(
    scene,
    side: str,
    array_size,
    pattern: str,
    polarization: str,
) -> int:
    """Configure one of Sionna's scene-level planar antenna arrays.

    ``array_size`` follows the UI's ``[horizontal, vertical]`` convention, so
    horizontal maps to PlanarArray columns and vertical maps to rows. The return
    value is Sionna's number of linearly polarized antenna ports; dual-polarized
    elements therefore contribute two ports.
    """
    from sionna.rt import PlanarArray

    if side not in ("tx", "rx"):
        raise ValueError(f"Unknown antenna-array side: {side}")
    try:
        cols, rows = int(array_size[0]), int(array_size[1])
    except (IndexError, TypeError, ValueError) as exc:
        raise ValueError(f"{side.upper()} antennaArraySize must be [horizontal, vertical]") from exc
    if cols < 1 or rows < 1:
        raise ValueError(f"{side.upper()} antennaArraySize entries must both be at least 1")

    array = PlanarArray(
        num_rows=rows,
        num_cols=cols,
        vertical_spacing=0.5,
        horizontal_spacing=0.5,
        pattern=pattern,
        polarization=polarization,
    )
    setattr(scene, f"{side}_array", array)
    return int(array.num_ant)


def _uniform_array_size(devices, label: str) -> tuple[int, int]:
    """Return the shared [horizontal, vertical] size or reject mixed arrays."""
    if not devices:
        raise ValueError(f"CIR export needs at least one {label.lower()}")
    try:
        sizes = [tuple(int(v) for v in device.antennaArraySize) for device in devices]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} antennaArraySize must be [horizontal, vertical]") from exc
    if any(len(size) != 2 or size[0] < 1 or size[1] < 1 for size in sizes):
        raise ValueError(f"{label} antennaArraySize entries must both be at least 1")
    if any(size != sizes[0] for size in sizes[1:]):
        raise ValueError(
            f"CIR export requires matching antennaArraySize across {label.lower()}s"
        )
    return sizes[0]


def _set_tx_array(scene, array_size, opts: SolverOptions | None = None) -> int:
    """Set the scene-wide Tx array from the requested Sionna configuration.

    Returns the number of antenna ports. With this array + transmitter orientation,
    the default uniform precoding forms the main lobe along boresight, so the
    beam genuinely steers (both PathSolver and RadioMapSolver respect it).
    """
    opts = opts or SolverOptions()
    return _set_planar_array(
        scene, "tx", array_size, opts.txPattern, opts.txPolarization
    )


def _set_rx_array(scene, array_size, opts: SolverOptions | None = None) -> int:
    """Set the scene-wide Rx array exactly as a Sionna notebook would."""
    opts = opts or SolverOptions()
    return _set_planar_array(
        scene, "rx", array_size, opts.rxPattern, opts.rxPolarization
    )


def _place_tx(scene, name: str, pos: list[float], beam: list[float] | None,
              power_dbm: float | None = None):
    """Add a transmitter to the scene, oriented toward its steered beam target."""
    from sionna.rt import Transmitter as RtTransmitter

    kwargs: dict = {"name": name, "position": pos}
    if power_dbm is not None:
        kwargs["power_dbm"] = float(power_dbm)
    tx_dev = RtTransmitter(**kwargs)
    if beam is not None:
        try:
            tx_dev.look_at([float(v) for v in beam])  # boresight = beam dir
        except Exception:
            pass
    scene.add(tx_dev)
    return tx_dev


def _trace_paths(scene, max_depth: int, opts: SolverOptions | None):
    """Run PathSolver on the scene with the request's interaction switches."""
    from sionna.rt import PathSolver

    opts = opts or SolverOptions()
    return PathSolver()(scene, max_depth=int(max(0, max_depth)),
                        samples_per_src=int(opts.pathSamplesPerSource),
                        seed=int(opts.pathSeed),
                        los=opts.los,
                        specular_reflection=opts.specularReflection,
                        diffuse_reflection=opts.diffuseReflection,
                        refraction=opts.refraction,
                        diffraction=opts.diffraction,
                        edge_diffraction=opts.edgeDiffraction,
                        synthetic_array=True)


def _device_z(
    enu: ENUVector,
    height: float,
    buildings: list[BuildingFootprint],
    height_reference: str | None = None,
) -> float:
    """Resolve device Z from its declared vertical datum.

    Legacy/manual devices (height_reference=None) retain the historical roof+height
    behaviour. Imported base stations can explicitly use AGL, above-roof, or
    absolute local scene Z. Terrain is assumed flat at scene Z=0 for AGL.
    """
    ref = height_reference or "roof"
    value = float(height)
    if ref in ("agl", "scene_z"):
        return value
    if ref != "roof":
        raise ValueError(f"Unsupported transmitter heightReference: {ref}")

    from shapely.geometry import Point, Polygon
    pt = Point(enu.x, enu.y)
    roof = 0.0
    for b in buildings:
        if b.category != "building" or len(b.enuPoints) < 3:
            continue
        try:
            if Polygon([(p.x, p.y) for p in b.enuPoints]).contains(pt):
                roof = max(roof, float(b.height))
        except Exception:
            continue
    return roof + value


def _beamform(a_coeffs: np.ndarray, n_tx_ant: int, num_paths: int) -> np.ndarray:
    """Apply the unit-norm uniform Tx precoder while preserving every Rx port.

    Input is one Tx/Rx-device pair with layout
    ``[num_rx_ant, num_tx_ant, num_paths]`` (a flat array is accepted for the
    pure-math tests). Output is ``[num_rx_ant, num_paths]``. Receive ports are
    deliberately not coherently collapsed: Sionna's physical receive-array
    response, including element patterns and geometry-dependent phase, remains
    intact for the receive-power reduction.
    """
    n_tx = max(1, int(n_tx_ant))
    n_paths = max(0, int(num_paths))
    a = np.asarray(a_coeffs, dtype=complex)
    if n_paths == 0:
        return np.zeros((1, 0), dtype=complex)

    expected_per_rx = n_tx * n_paths
    if a.size % expected_per_rx:
        raise ValueError(
            f"Path coefficient size {a.size} is incompatible with "
            f"{n_tx} Tx ports × {n_paths} paths"
        )
    n_rx = max(1, a.size // expected_per_rx)
    a = a.reshape(n_rx, n_tx, n_paths)
    return a.sum(axis=1) / math.sqrt(n_tx)


def _rx_path_power(a_path: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return per-path power across physical Rx ports and a phase reference.

    Summing ``|a|²`` over receive ports is the signal-power term used by ideal
    MRC with equal, independent receiver noise. It lets scalar link/mobility
    KPIs benefit from the actual Sionna array response without inventing a
    separate ``10*log10(Nr)`` gain. The strongest port supplies a stable phase
    reference for the legacy scalar path visualization.
    """
    a = np.asarray(a_path, dtype=complex)
    if a.ndim == 1:
        a = a[None, :]
    if a.ndim != 2:
        raise ValueError("Receive path coefficients must be [num_rx_ant, num_paths]")
    power = np.sum(np.abs(a) ** 2, axis=0)
    strongest_port = np.argmax(np.abs(a), axis=0)
    reference = a[strongest_port, np.arange(a.shape[1])]
    return power, reference


def _build_paths(
    valid: np.ndarray,
    tau: np.ndarray,
    a_path: np.ndarray,
    doppler: np.ndarray,
    interactions: np.ndarray,
    vertices: np.ndarray,
    theta_t: np.ndarray,
    phi_t: np.ndarray,
    theta_r: np.ndarray,
    phi_r: np.ndarray,
    tx_pos: list[float],
    rx_pos: list[float],
    power_dbm: float,
    tx_id: str | None = None,
) -> tuple[list[PropagationPath], float]:
    """Turn one receiver's per-path arrays into PropagationPath objects.

    Inputs are already reduced to a single (rx, tx) pair: ``valid``/``tau``/
    ``doppler``/angles are shape ``(num_paths,)`` and ``a_path`` is
    ``(num_rx_ant, num_paths)`` after Tx precoding. ``interactions`` is
    ``(depth, num_paths)`` and ``vertices`` is ``(depth, num_paths, 3)``.
    Returns the full path list (strongest first) plus max |Doppler| [Hz].
    """
    num_paths = int(valid.shape[0])
    depth = int(interactions.shape[0])
    path_power, phase_reference = _rx_path_power(a_path)
    tx_vec = ENUVector(x=tx_pos[0], y=tx_pos[1], z=tx_pos[2])
    rx_vec = ENUVector(x=rx_pos[0], y=rx_pos[1], z=rx_pos[2])

    out: list[PropagationPath] = []
    max_doppler = 0.0
    for p in range(num_paths):
        if not valid[p] or not np.isfinite(tau[p]):
            continue
        bounce_pts: list[ENUVector] = []
        order = 0
        kinds: list[int] = []
        for d in range(depth):
            itype = int(interactions[d, p])
            if itype == 0:  # InteractionType.NONE
                continue
            v = vertices[d, p]
            if not np.all(np.isfinite(v)):
                continue
            bounce_pts.append(ENUVector(x=float(v[0]), y=float(v[1]), z=float(v[2])))
            order += 1
            kinds.append(itype)

        points = [tx_vec, *bounce_pts, rx_vec]
        distance = float(sum(
            math.dist((points[i].x, points[i].y, points[i].z),
                      (points[i + 1].x, points[i + 1].y, points[i + 1].z))
            for i in range(len(points) - 1)
        ))
        # Tx precoding and the physical Sionna Rx array are both already in
        # `path_power`; do not add a separate analytic receive-array gain.
        gain = float(path_power[p])
        rx_power = power_dbm + 10.0 * math.log10(max(gain, 1e-30))
        path_loss = power_dbm - rx_power
        if np.isfinite(doppler[p]):
            max_doppler = max(max_doppler, abs(float(doppler[p])))
        aod_az, aod_el = _az_el(theta_t[p], phi_t[p])
        aoa_az, aoa_el = _az_el(theta_r[p], phi_r[p])
        out.append(PropagationPath(
            id=f"path_{p}",
            points=points,
            type=_path_type(order, kinds),
            order=order,
            distance=distance,
            pathLossDb=path_loss,
            receivedPowerDbm=rx_power,
            delayNs=float(tau[p]) * 1e9,
            phasesRad=[float(np.angle(phase_reference[p]))],
            materialsReached=[],
            interactionKinds=[_INTERACTION_NAMES.get(k, "other") for k in kinds],
            aodAzimuthDeg=aod_az, aodElevationDeg=aod_el,
            aoaAzimuthDeg=aoa_az, aoaElevationDeg=aoa_el,
            txId=tx_id,
        ))

    out.sort(key=lambda pp: pp.receivedPowerDbm, reverse=True)
    return out, max_doppler


def _solve_at(
    scene,
    tx_pos: list[float],
    rx_pos: list[float],
    power_dbm: float,
    n_tx_ant: int,
    beam_target: list[float] | None = None,
    rx_velocity: list[float] | None = None,
    max_depth: int = MAX_DEPTH,
    opts: SolverOptions | None = None,
    tx_id: str | None = None,
) -> tuple[list[PropagationPath], float]:
    """Run PathSolver for one Tx/Rx placement; return paths + max |Doppler| (Hz).

    Returns the *full* path list (sorted by received power, strongest first).
    Channel KPIs are computed over this complete set by the caller; the display
    cap to MAX_PATHS is applied separately so the metrics stay faithful to Sionna.

    The Tx is oriented toward ``beam_target`` (real beamsteering): its directive
    array is combined with uniform precoding, so paths off the beam get less power.
    """
    from sionna.rt import Receiver as RtReceiver

    _clear_devices(scene)
    _place_tx(scene, "tx_d", tx_pos, beam_target)
    rx_dev = RtReceiver(name="rx_d", position=rx_pos)
    if rx_velocity is not None:
        try:
            rx_dev.velocity = [float(v) for v in rx_velocity]
        except Exception:
            pass
    scene.add(rx_dev)

    paths = _trace_paths(scene, max_depth, opts)

    valid = np.squeeze(to_numpy(paths.valid)).astype(bool).reshape(-1)
    num_paths = int(valid.shape[0])
    if num_paths == 0:
        return [], 0.0

    vraw = to_numpy(paths.vertices)
    depth = vraw.shape[0]
    vertices = vraw.reshape(depth, -1, 3).reshape(depth, num_paths, 3)
    interactions = to_numpy(paths.interactions).reshape(depth, num_paths)
    tau = np.squeeze(to_numpy(paths.tau)).reshape(-1)[:num_paths]
    a_real, a_imag = paths.a
    a_full = to_numpy(a_real).astype(float) + 1j * to_numpy(a_imag).astype(float)
    # One device pair: [num_rx_ant, num_tx_ant, num_paths]. Apply only the Tx
    # precoder and preserve every physical receive port.
    a_pair = a_full[0, :, 0, :, :]
    a_path = _beamform(a_pair, n_tx_ant, num_paths)
    try:
        doppler = np.squeeze(to_numpy(paths.doppler)).reshape(-1)[:num_paths]
    except Exception:
        doppler = np.zeros(num_paths)

    # Angles of departure (Tx) / arrival (Rx): zenith (theta) + azimuth (phi) [rad].
    def _angles(attr) -> np.ndarray:
        try:
            return np.squeeze(to_numpy(getattr(paths, attr))).reshape(-1)[:num_paths]
        except Exception:
            return np.full(num_paths, np.nan)

    theta_t, phi_t = _angles("theta_t"), _angles("phi_t")
    theta_r, phi_r = _angles("theta_r"), _angles("phi_r")

    # Build PropagationPaths from this single (rx, tx) pair. The caller computes
    # KPIs over the FULL returned list and caps to MAX_PATHS only for display —
    # Sionna's PathSolver can emit far more than MAX_PATHS, so truncating before
    # the metrics would understate path count and delay spread.
    return _build_paths(valid, tau, a_path, doppler, interactions, vertices,
                        theta_t, phi_t, theta_r, phi_r,
                        tx_pos, rx_pos, power_dbm, tx_id=tx_id)


def _solve_batched(
    scene,
    tx_specs: list[_TxSpec],
    rx_positions: list[list[float]],
    rx_velocities: list[list[float]],
    n_tx_ant: int,
    max_depth: int = MAX_DEPTH,
    opts: SolverOptions | None = None,
    return_native: bool = False,
) -> list[list[tuple[list[PropagationPath], float]]] | tuple[list[list[tuple[list[PropagationPath], float]]], object]:
    """Ray-trace every (waypoint, transmitter) pair in a SINGLE PathSolver dispatch.

    Sionna computes paths independently per (rx, tx) pair, so adding every
    transmitter AND every waypoint-receiver to the scene and solving once yields
    the same per-pair paths as calling ``_solve_at`` for each — but with one GPU
    launch instead of N×M (the mobility speed-up, now spanning all transmitters).

    With ``synthetic_array`` the geometric tensors carry explicit rx/tx axes:
    valid/tau/doppler/angles are ``(num_rx, num_tx, num_paths)``, interactions
    ``(depth, num_rx, num_tx, num_paths)``, vertices ``(…, 3)``, and the
    coefficients a are ``(num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths)``.

    Returns ``results[rx_index][tx_index] = (paths, max|Doppler|)`` — one entry
    per transmitter for each receiver, both in input order.
    """
    from sionna.rt import Receiver as RtReceiver

    _clear_devices(scene)
    for j, spec in enumerate(tx_specs):
        _place_tx(scene, f"tx_b_{j}", spec.pos, spec.beam)
    for i, (pos, vel) in enumerate(zip(rx_positions, rx_velocities)):
        rx_dev = RtReceiver(name=f"rx_b_{i}", position=pos)
        try:
            rx_dev.velocity = [float(v) for v in vel]  # per-rx Doppler heading
        except Exception:
            pass
        scene.add(rx_dev)

    paths = _trace_paths(scene, max_depth, opts)

    valid = to_numpy(paths.valid).astype(bool)     # (num_rx, num_tx, num_paths)
    num_rx = valid.shape[0]
    num_tx = valid.shape[1]
    num_paths = valid.shape[-1]
    tau = to_numpy(paths.tau)
    a_real, a_imag = paths.a
    a_full = to_numpy(a_real).astype(float) + 1j * to_numpy(a_imag).astype(float)
    inter = to_numpy(paths.interactions)
    vert = to_numpy(paths.vertices)
    depth = vert.shape[0]
    try:
        dopp = to_numpy(paths.doppler)
    except Exception:
        dopp = np.zeros_like(tau)

    def _ang(attr) -> np.ndarray:
        try:
            return to_numpy(getattr(paths, attr))
        except Exception:
            return np.full((num_rx, num_tx, num_paths), np.nan)

    theta_t, phi_t = _ang("theta_t"), _ang("phi_t")
    theta_r, phi_r = _ang("theta_r"), _ang("phi_r")

    results: list[list[tuple[list[PropagationPath], float]]] = []
    for r in range(num_rx):
        per_tx: list[tuple[list[PropagationPath], float]] = []
        for t in range(num_tx):
            valid_rt = valid[r, t, :].reshape(-1)
            if valid_rt.shape[0] == 0:
                per_tx.append(([], 0.0))
                continue
            tau_rt = tau[r, t, :].reshape(-1)[:num_paths]
            # Preserve the physical Rx-port axis while applying the same
            # unit-norm Tx precoder as the single-pair solve.
            a_path_rt = _beamform(a_full[r, :, t, :, :], n_tx_ant, num_paths)
            dopp_rt = dopp[r, t, :].reshape(-1)[:num_paths]
            inter_rt = inter[:, r, t, :].reshape(depth, num_paths)
            vert_rt = vert[:, r, t, :, :].reshape(depth, num_paths, 3)
            tt_rt = theta_t[r, t, :].reshape(-1)[:num_paths]
            pt_rt = phi_t[r, t, :].reshape(-1)[:num_paths]
            tr_rt = theta_r[r, t, :].reshape(-1)[:num_paths]
            pr_rt = phi_r[r, t, :].reshape(-1)[:num_paths]
            spec = tx_specs[t]
            per_tx.append(_build_paths(valid_rt, tau_rt, a_path_rt, dopp_rt, inter_rt, vert_rt,
                                       tt_rt, pt_rt, tr_rt, pr_rt,
                                       spec.pos, rx_positions[r], spec.power_dbm,
                                       tx_id=spec.id))
        results.append(per_tx)
    return (results, paths) if return_native else results


def solve_link(req: SolveRequest) -> tuple[list[PropagationPath], ChannelMetrics]:
    scene = build_scene(req.buildings, req.freqGhz, req.materials)
    tx_pos = [float(req.tx.enu.x), float(req.tx.enu.y),
              _device_z(req.tx.enu, req.tx.height, req.buildings, getattr(req.tx, "heightReference", None))]
    rx_pos = [float(req.rx.enu.x), float(req.rx.enu.y),
              _device_z(req.rx.enu, req.rx.height, req.buildings)]
    n_tx_ant = _set_tx_array(scene, req.tx.antennaArraySize, req.options)
    _set_rx_array(scene, req.rx.antennaArraySize, req.options)
    beam = _beam_target(tx_pos, req.tx.beamsteeringAzimuth, req.tx.beamsteeringElevation)
    paths, _ = _solve_at(scene, tx_pos, rx_pos, req.tx.powerDbm, n_tx_ant,
                         beam_target=beam, max_depth=req.maxDepth,
                         opts=req.options)
    # KPIs over the full path set; only the displayed rays are capped to MAX_PATHS.
    metrics = _channel_metrics(paths)
    return paths[:MAX_PATHS], metrics


def _cir_request_devices(req, plural: str, singular: str, label: str):
    """Resolve multi-device CIR fields while retaining KPI/PHY request support."""
    resolver = getattr(req, plural, None)
    if callable(resolver):
        return resolver()
    devices = getattr(req, f"{singular}s", None)
    if devices:
        return list(devices)
    device = getattr(req, singular, None)
    if device is not None:
        return [device]
    raise ValueError(f"CIR export needs `{singular}s` or `{singular}` ({label})")


def _notebook_tau_shape(a, tau) -> np.ndarray:
    """Return delays with the antenna axes shown in the Sionna RT tutorial.

    With synthetic arrays, Sionna 2.0.1 can return geometric delays as
    [rx, tx, path]. Every synthetic antenna pair shares those delays, so they
    can be broadcast losslessly to [rx, rx_ant, tx, tx_ant, path].
    """
    a_array = np.asarray(a)
    tau_array = np.asarray(tau, dtype=float)
    expected_shape = a_array.shape[:-1]
    if tau_array.shape == expected_shape:
        return tau_array
    if (
        a_array.ndim == 6
        and tau_array.ndim == 3
        and tau_array.shape
        == (a_array.shape[0], a_array.shape[2], a_array.shape[4])
    ):
        return np.broadcast_to(
            tau_array[:, np.newaxis, :, np.newaxis, :],
            expected_shape,
        ).copy()
    raise ValueError(
        f"Unexpected CIR delay shape {tau_array.shape} "
        f"for coefficient shape {a_array.shape}"
    )


def solve_cir(req) -> dict:
    """Run one PathSolver dispatch for all requested devices and return CIR/CFR.

    Faithful to the Python workflow::

        # Add every Tx and Rx to the same scene first
        p_solver = PathSolver()
        paths = p_solver(scene, max_depth=...)
        a, tau = paths.cir(normalize_delays=..., out_type="numpy")
        freqs = subcarrier_frequencies(num_subcarriers, subcarrier_spacing)
        h = paths.cfr(frequencies=freqs, normalize_delays=..., out_type="numpy")

    ``a`` has native Sionna layout
    [num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths, num_time_steps],
    while synthetic-array ``tau`` may use the compact geometric layout
    [num_rx, num_tx, num_paths]. The NPZ writer broadcasts those shared delays
    over antenna axes for compatibility with the Sionna tutorial layout.
    """
    from sionna.rt import Receiver as RtReceiver, subcarrier_frequencies

    txs = _cir_request_devices(req, "transmitters", "tx", "transmitter")
    rxs = _cir_request_devices(req, "receivers", "rx", "receiver")
    tx_size = _uniform_array_size(txs, "Transmitter")
    rx_size = _uniform_array_size(rxs, "Receiver")

    scene = build_scene(req.buildings, req.freqGhz, getattr(req, "materials", None))
    tx_positions = np.asarray([
        [float(tx.enu.x), float(tx.enu.y),
         _device_z(tx.enu, tx.height, req.buildings, getattr(tx, "heightReference", None))]
        for tx in txs
    ], dtype=float)
    rx_positions = np.asarray([
        [float(rx.enu.x), float(rx.enu.y),
         _device_z(rx.enu, rx.height, req.buildings)]
        for rx in rxs
    ], dtype=float)
    n_tx_ant = _set_tx_array(scene, tx_size, req.options)
    n_rx_ant = _set_rx_array(scene, rx_size, req.options)

    _clear_devices(scene)
    for index, (tx, tx_pos_arr) in enumerate(zip(txs, tx_positions)):
        tx_pos = tx_pos_arr.tolist()
        beam = _beam_target(
            tx_pos, tx.beamsteeringAzimuth, tx.beamsteeringElevation
        )
        _place_tx(scene, f"tx_cir_{index}", tx_pos, beam)
    for index, rx_pos in enumerate(rx_positions):
        scene.add(RtReceiver(name=f"rx_cir_{index}", position=rx_pos.tolist()))

    paths = _trace_paths(scene, req.maxDepth, req.options)

    # CIR: complex baseband path coefficients a and propagation delays tau [s].
    a, tau = paths.cir(normalize_delays=bool(req.normalizeDelays), out_type="numpy")

    # Raw CIR export deliberately does not construct a frequency grid or CFR.
    include_cfr = getattr(req, "format", "npz") != "cir_npz"
    num_sc = max(1, int(req.numSubcarriers)) if include_cfr else 0
    spacing = float(req.subcarrierSpacing)
    if include_cfr:
        freqs = subcarrier_frequencies(num_sc, spacing)
        h = paths.cfr(
            frequencies=freqs,
            normalize_delays=bool(req.normalizeDelays),
            out_type="numpy",
        )
        frequencies = np.asarray(to_numpy(freqs), dtype=float)
        h_array = np.asarray(h)
    else:
        frequencies = np.asarray([], dtype=float)
        h_array = None

    a_array = np.asarray(a)

    return {
        "a": a_array,                              # complex CIR coefficients
        "tau": np.asarray(tau, dtype=float),        # delays [s]
        "h": h_array,                              # complex CFR (None for raw CIR)
        "frequencies": frequencies,                # baseband offsets [Hz]
        "carrier_frequency": float(np.asarray(to_numpy(scene.frequency)).reshape(-1)[0]),
        "subcarrier_spacing": spacing,
        "num_subcarriers": num_sc,
        "num_paths": int(a_array.shape[-2]) if a_array.ndim >= 2 else 0,
        "num_tx": len(txs),
        "num_rx": len(rxs),
        "num_tx_ant": n_tx_ant,
        "num_rx_ant": n_rx_ant,
        "tx_array": np.asarray(tx_size, dtype=int),
        "rx_array": np.asarray(rx_size, dtype=int),
        "tx_ids": np.asarray([tx.id for tx in txs], dtype=str),
        "rx_ids": np.asarray([rx.id for rx in rxs], dtype=str),
        "tx_names": np.asarray([tx.name for tx in txs], dtype=str),
        "rx_names": np.asarray([rx.name for rx in rxs], dtype=str),
        "tx_positions": tx_positions,
        "rx_positions": rx_positions,
    }


def solve_channel_grid(req) -> dict:
    """Ray-trace a per-cell channel grid over the radio-map cells.

    This is the physics-based counterpart to the frontend's coverage proxy.
    For every cell it runs Sionna's PathSolver and keeps the real
    ``paths.cfr()`` channel frequency response with its full Tx- and Rx-antenna
    axes rather than a beamformed scalar, plus ray-traced LOS and
    channel-derived received power. Receivers are batched ``chunkSize`` at a
    time into PathSolver dispatches, so the whole grid costs a handful of GPU
    launches instead of one per cell.

    Returns NumPy arrays ready for ``.npz`` packing::

        h                  complex64 [n_cells, n_rx_ant, n_tx_ant, n_subcarrier]
        coordinates        float     [n_cells, 3]  (ENU)
        los                bool      [n_cells]     (order-0 path present)
        received_power_dbm float     [n_cells]
    """
    from sionna.rt import Receiver as RtReceiver, subcarrier_frequencies

    cells = req.cells
    n_cells = len(cells)
    if n_cells == 0:
        raise ValueError("Channel-grid export needs at least one cell")
    if n_cells > MAX_CHANNEL_GRID_CELLS:
        raise ValueError(
            f"Ray-traced channel export is capped at {MAX_CHANNEL_GRID_CELLS} cells "
            f"({n_cells} requested). Recompute coverage with a coarser grid size."
        )

    scene = build_scene(req.buildings, req.freqGhz, getattr(req, "materials", None))
    # Both arrays are physical Sionna PlanarArrays. Every cell Receiver shares
    # this one scene.rx_array, matching the scene-level array rule.
    n_tx_ant = _set_tx_array(scene, req.tx.antennaArraySize, req.options)
    rx_size = req.rx.antennaArraySize if req.rx is not None else (1, 1)
    n_rx_ant = _set_rx_array(scene, rx_size, req.options)
    tx_pos = [float(req.tx.enu.x), float(req.tx.enu.y),
              _device_z(req.tx.enu, req.tx.height, req.buildings, getattr(req.tx, "heightReference", None))]
    beam = _beam_target(tx_pos, req.tx.beamsteeringAzimuth, req.tx.beamsteeringElevation)

    num_sc = max(1, int(req.numSubcarriers))
    spacing = float(req.subcarrierSpacing)
    freqs = subcarrier_frequencies(num_sc, spacing)
    opts = req.options
    chunk = max(1, int(req.chunkSize))

    # Cell centers are used verbatim as receiver positions so the exported
    # coordinates line up 1:1 with the displayed coverage grid.
    coords = np.array([[float(c.x), float(c.y), float(c.z)] for c in cells], dtype=float)
    h_blocks: list[np.ndarray] = []
    los_all = np.zeros(n_cells, dtype=bool)
    power_all = np.full(n_cells, -np.inf, dtype=float)

    for start in range(0, n_cells, chunk):
        block = coords[start:start + chunk]
        _clear_devices(scene)
        _place_tx(scene, "tx_grid", tx_pos, beam)
        for i, pos in enumerate(block):
            scene.add(RtReceiver(name=f"rx_grid_{i}",
                                 position=[float(pos[0]), float(pos[1]), float(pos[2])]))

        paths = _trace_paths(scene, req.maxDepth, opts)

        # CFR sampled on the OFDM grid. Sionna returns the per-antenna channel as
        # [num_rx, num_rx_ant, num_tx, num_tx_ant, num_time, num_sc] — with one
        # transmitter and no mobility the num_tx / num_time axes are singletons.
        # Reshape to a fixed [num_rx, num_rx_ant, num_tx_ant, num_sc] layout from
        # the known dims (the size-1 axes fold away without reordering).
        h = np.asarray(paths.cfr(frequencies=freqs,
                                 normalize_delays=bool(req.normalizeDelays),
                                 out_type="numpy"))
        nrx = len(block)
        expected = nrx * n_rx_ant * n_tx_ant * num_sc
        if h.size != expected:
            raise ValueError(
                f"Unexpected CFR size {h.size}; expected {expected} for "
                f"{nrx} receivers × {n_rx_ant} Rx ports × "
                f"{n_tx_ant} Tx ports × {num_sc} subcarriers"
            )
        h = h.reshape(nrx, n_rx_ant, n_tx_ant, num_sc)
        h_blocks.append(h.astype(np.complex64))

        # Ray-traced LOS: a valid path with zero interactions (order 0) exists.
        valid = to_numpy(paths.valid).astype(bool)   # [num_rx, num_tx, num_paths]
        inter = to_numpy(paths.interactions)          # [depth, num_rx, num_tx, num_paths]
        for r in range(nrx):
            vr = valid[r, 0, :].reshape(-1)
            if inter.ndim == 4 and inter.size:
                order = (inter[:, r, 0, :] != 0).sum(axis=0).reshape(-1)
                los_all[start + r] = bool(np.any(vr & (order == 0)))
            else:
                los_all[start + r] = bool(np.any(vr))

        # Received power with unit-norm uniform Tx precoding. Sum physical Rx-port
        # powers (the MRC signal-power term), then average over subcarriers.
        hb = h.sum(axis=2) / math.sqrt(max(1, n_tx_ant))   # [num_rx, num_rx_ant, num_sc]
        p_lin = (np.abs(hb) ** 2).sum(axis=1).mean(axis=1)  # [num_rx]
        with np.errstate(divide="ignore"):
            p_dbm = float(req.tx.powerDbm) + 10.0 * np.log10(p_lin)
        p_dbm[~np.isfinite(p_dbm)] = -np.inf
        power_all[start:start + nrx] = p_dbm

    H = (np.concatenate(h_blocks, axis=0) if h_blocks
         else np.zeros((0, 1, max(1, n_tx_ant), num_sc), dtype=np.complex64))
    carrier = float(np.asarray(to_numpy(scene.frequency)).reshape(-1)[0])
    return {
        "h": H,                                # [n_cells, n_rx_ant, n_tx_ant, n_sc]
        "coordinates": coords,                 # [n_cells, 3] ENU
        "los": los_all,                        # [n_cells] ray-traced LOS
        "received_power_dbm": power_all,       # [n_cells]
        "frequencies": np.asarray(to_numpy(freqs), dtype=float),
        "carrier_frequency": carrier,
        "subcarrier_spacing": spacing,
        "tx_power_dbm": float(req.tx.powerDbm),
        # [horizontal, vertical] element counts, as configured in the UI.
        "tx_array": np.asarray([int(req.tx.antennaArraySize[0]),
                                int(req.tx.antennaArraySize[1])]),
        "rx_array": np.asarray([int(rx_size[0]), int(rx_size[1])]),
        "num_tx_ant": n_tx_ant,
        "num_rx_ant": n_rx_ant,
        "num_cells": n_cells,
    }


def _mobility_step(
    index: int,
    rx_pos: list[float],
    tx_specs: list[_TxSpec],
    per_tx_results: list[tuple[list[PropagationPath], float]],
    combine: str = "best_server",
):
    """Assemble one waypoint's MobilityStep from each transmitter's solved link.

    ``combine`` selects what the scalar KPIs report:

    * ``"best_server"`` — the single strongest transmitter (instantaneous
      association); its metrics become the headline and ``servingTx*`` names it.
    * ``"sum"`` — non-coherent incident power aggregated over every transmitter;
      there is no single server, so ``servingTx*`` is left unset. A joint delay
      spread is deliberately not reported because independent transmitters do
      not share a delay/phase reference without an explicit synchronization
      model; their individual delay spreads remain available in ``perTx``.

    Either way the rays from every transmitter are merged (strongest first, each
    tagged with its ``txId``) so the scene shows all links and association changes.
    """
    from .models import MobilityStep, TxLinkMetrics

    per_tx_metrics: list[TxLinkMetrics] = []
    union_paths: list[PropagationPath] = []   # capped per-Tx, for display
    best_idx = -1
    best_power = -math.inf
    best_metrics: ChannelMetrics | None = None
    best_doppler = 0.0
    max_doppler_all = 0.0

    for t, (paths_t, dop_t) in enumerate(per_tx_results):
        metrics_t = _channel_metrics(paths_t)
        spec = tx_specs[t]
        per_tx_metrics.append(TxLinkMetrics(
            txId=spec.id or f"tx_{t}",
            txName=spec.name or f"Tx {t + 1}",
            receivedPowerDbm=metrics_t.totalRxPowerDbm,
            rmsDelaySpreadNs=metrics_t.rmsDelaySpreadNs,
            numPaths=metrics_t.numPaths,
            maxDopplerHz=float(dop_t),
            losStatus=metrics_t.losStatus,
        ))
        # Cap each Tx's rays to MAX_PATHS for display (KPIs use the full set);
        # the union across transmitters is what the 3D scene renders.
        union_paths.extend(paths_t[:MAX_PATHS])
        max_doppler_all = max(max_doppler_all, float(dop_t))
        if paths_t and metrics_t.totalRxPowerDbm > best_power:
            best_power = metrics_t.totalRxPowerDbm
            best_idx = t
            best_metrics = metrics_t
            best_doppler = float(dop_t)

    union_paths.sort(key=lambda pp: pp.receivedPowerDbm, reverse=True)
    rx_vec = ENUVector(x=rx_pos[0], y=rx_pos[1], z=rx_pos[2])

    if best_metrics is None:  # no transmitter reached this waypoint
        empty = _empty_metrics()
        return MobilityStep(
            index=index, rxPosition=rx_vec,
            receivedPowerDbm=empty.totalRxPowerDbm,
            rmsDelaySpreadNs=empty.rmsDelaySpreadNs,
            rmsDelaySpreadValid=combine != "sum",
            numPaths=0, maxDopplerHz=0.0, losStatus=empty.losStatus,
            paths=[], perTx=per_tx_metrics,
        )

    if combine == "sum":
        # Non-coherent total incident power. Do not merge delays/phases across
        # independently transmitting cells: that would silently assume a shared
        # clock and waveform. Per-Tx channel metrics above remain well defined.
        reachable = [metric for metric in per_tx_metrics if metric.numPaths > 0]
        total_mw = sum(10.0 ** (m.receivedPowerDbm / 10.0) for m in reachable)
        # -200 dBm is the API's finite no-path sentinel. Summing sentinel
        # values would manufacture a 10*log10(N_tx) gain, so exclude them.
        aggregate_dbm = (10.0 * math.log10(max(total_mw, 1e-30))
                         if reachable else -300.0)
        return MobilityStep(
            index=index, rxPosition=rx_vec,
            receivedPowerDbm=aggregate_dbm,
            rmsDelaySpreadNs=0.0,
            rmsDelaySpreadValid=False,
            numPaths=sum(m.numPaths for m in per_tx_metrics),
            maxDopplerHz=max_doppler_all,
            losStatus="LOS" if any(m.losStatus == "LOS" for m in reachable) else "NLOS",
            paths=union_paths,
            servingTxId=None,        # combined over all Tx — no single server
            servingTxName=None,
            perTx=per_tx_metrics,
        )

    serving = tx_specs[best_idx]
    return MobilityStep(
        index=index, rxPosition=rx_vec,
        receivedPowerDbm=best_metrics.totalRxPowerDbm,
        rmsDelaySpreadNs=best_metrics.rmsDelaySpreadNs,
        numPaths=best_metrics.numPaths,
        maxDopplerHz=best_doppler,
        losStatus=best_metrics.losStatus,
        paths=union_paths,
        servingTxId=serving.id,
        servingTxName=serving.name,
        perTx=per_tx_metrics,
    )


def solve_mobility(req) -> tuple[list, dict, "HandoverAnalysis | None"]:
    """Best-server mobility: ray-trace EVERY transmitter to each Rx waypoint.

    All transmitters and all waypoints go into a single batched PathSolver
    dispatch (Sionna solves each (rx, tx) pair independently). For every waypoint
    each Tx's link is kept, the strongest becomes the serving cell (the step's
    scalar KPIs), and the union of all Tx rays is returned so the scene shows
    every link and association changes as the Rx moves. Falls back to
    per-(waypoint, Tx) solves if the batched extraction fails, so mobility always
    returns a result. With ≥ 2 transmitters the per-Tx RSS series is additionally
    run through the A3 hysteresis/TTT state machine (backend/handover.py).
    """
    import sys

    txs = req.transmitters()
    combine = getattr(req, "combineMode", "best_server")
    execution_mode = getattr(req, "executionMode", "auto")
    scene = build_scene(req.buildings, req.freqGhz, getattr(req, "materials", None))

    # One scene tx_array is shared by every transmitter (Sionna), so they must use
    # the same antenna geometry — the same rule the multi-Tx radio map enforces.
    array_sizes = [tuple(int(v) for v in t.antennaArraySize) for t in txs]
    if any(size != array_sizes[0] for size in array_sizes):
        raise ValueError(
            "Multi-transmitter mobility requires matching antennaArraySize across transmitters"
        )

    n_tx_ant = _set_tx_array(scene, txs[0].antennaArraySize, req.options)
    _set_rx_array(scene, req.rx.antennaArraySize, req.options)

    # Resolve each transmitter once (scene position, steered beam target, power).
    tx_specs: list[_TxSpec] = []
    for t in txs:
        pos = [float(t.enu.x), float(t.enu.y), _device_z(t.enu, t.height, req.buildings, getattr(t, "heightReference", None))]
        beam = _beam_target(pos, t.beamsteeringAzimuth, t.beamsteeringElevation)
        tx_specs.append(_TxSpec(pos=pos, beam=beam, power_dbm=float(t.powerDbm),
                                id=t.id, name=t.name))

    speed_ms = float(req.speedKmh) / 3.6
    wps = req.waypoints
    # Per-waypoint Rx position + velocity (heading toward the next waypoint; the
    # last waypoint reuses the previous heading), shared by both solve paths.
    rx_positions: list[list[float]] = []
    velocities: list[list[float]] = []
    for i, wp in enumerate(wps):
        rx_positions.append([float(wp.x), float(wp.y),
                             _device_z(wp, req.rx.height, req.buildings)])
        nxt = wps[i + 1] if i + 1 < len(wps) else wps[i - 1] if i > 0 else None
        velocity = [0.0, 0.0, 0.0]
        if nxt is not None:
            dx, dy = float(nxt.x) - float(wp.x), float(nxt.y) - float(wp.y)
            norm = math.hypot(dx, dy)
            if i + 1 >= len(wps):
                dx, dy = -dx, -dy  # keep heading direction on the last point
            if norm > 1e-6:
                velocity = [dx / norm * speed_ms, dy / norm * speed_ms, 0.0]
        velocities.append(velocity)

    # Fast path: one GPU dispatch for all (waypoint, Tx) pairs. Defensive fallback
    # to per-(waypoint, Tx) solves if the batched extraction misbehaves.
    per_wp: list[list[tuple[list, float]]] | None = None
    if execution_mode != "serial_reference":
        try:
            per_wp = _solve_batched(scene, tx_specs, rx_positions, velocities,
                                    n_tx_ant,
                                    max_depth=req.maxDepth, opts=req.options)
            if len(per_wp) != len(wps):
                per_wp = None
        except Exception as exc:  # pragma: no cover - defensive fallback
            logger.warning("Batched mobility solve failed; falling back to per-waypoint solves: %s", exc)
            per_wp = None
        if execution_mode == "batched" and per_wp is None:
            raise RuntimeError("Required batched mobility execution did not produce a valid result")

    batched_result_used = per_wp is not None
    steps: list = []
    for i in range(len(wps)):
        if per_wp is not None:
            per_tx_results = per_wp[i]
        else:
            per_tx_results = [
                _solve_at(scene, spec.pos, rx_positions[i], spec.power_dbm,
                          n_tx_ant, beam_target=spec.beam,
                          rx_velocity=velocities[i], max_depth=req.maxDepth,
                          opts=req.options, tx_id=spec.id)
                for spec in tx_specs
            ]
        steps.append(_mobility_step(i, rx_positions[i], tx_specs, per_tx_results, combine))
    pair_count = len(wps) * len(tx_specs)
    strategy = ("single_batched_dispatch" if batched_result_used else
                "serial_reference" if execution_mode == "serial_reference" else
                "serial_pair_fallback")
    execution = {
        "strategy": strategy,
        "batchedResultUsed": batched_result_used,
        "transmitterCount": len(tx_specs),
        "waypointCount": len(wps),
        "pairCount": pair_count,
        # Counts only successful PathSolver calls. A failed batched attempt is
        # intentionally not advertised as a completed dispatch.
        "successfulPathSolverDispatches": 1 if batched_result_used else pair_count,
        "samplesPerSource": int(req.options.pathSamplesPerSource),
        "seed": int(req.options.pathSeed),
    }
    return steps, execution, _handover_analysis(req, steps, tx_specs, rx_positions, speed_ms)


def _handover_analysis(req, steps: list, tx_specs: list[_TxSpec],
                       rx_positions: list[list[float]], speed_ms: float):
    """A3 hysteresis/TTT association over the solved per-Tx RSS series.

    Post-processing only (no GPU): meaningful with ≥ 2 transmitters, else None.
    """
    from .handover import a3_association, step_durations
    from .models import HandoverAnalysis, HandoverConfig, HandoverEvent

    if len(tx_specs) < 2 or not steps:
        return None
    cfg = getattr(req, "handover", None) or HandoverConfig()
    rss = [[m.receivedPowerDbm for m in s.perTx] for s in steps]
    result = a3_association(
        rss, step_durations(rx_positions, speed_ms),
        hysteresis_db=float(cfg.hysteresisDb),
        ttt_s=float(cfg.timeToTriggerMs) / 1000.0,
        ping_pong_window_s=float(cfg.pingPongWindowS),
    )

    def _tx_id(i: int) -> str:
        return tx_specs[i].id or f"tx_{i}"

    def _tx_name(i: int) -> str:
        return tx_specs[i].name or f"Tx {i + 1}"

    events = [HandoverEvent(stepIndex=e["stepIndex"], timeS=e["timeS"],
                            fromTxId=_tx_id(e["fromIdx"]), fromTxName=_tx_name(e["fromIdx"]),
                            toTxId=_tx_id(e["toIdx"]), toTxName=_tx_name(e["toIdx"]),
                            pingPong=e["pingPong"])
              for e in result["events"]]
    return HandoverAnalysis(
        hysteresisDb=float(cfg.hysteresisDb),
        timeToTriggerMs=float(cfg.timeToTriggerMs),
        pingPongWindowS=float(cfg.pingPongWindowS),
        servingTxIds=[_tx_id(i) if i >= 0 else None for i in result["servingIdx"]],
        events=events,
        handoverCount=len(events),
        pingPongCount=sum(1 for e in events if e.pingPong),
        instantaneousChangeCount=int(result["instantaneousChanges"]),
    )


def _az_el(theta_rad: float, phi_rad: float) -> tuple[float | None, float | None]:
    """Convert Sionna (zenith theta, azimuth phi) [rad] to the app's convention:
    azimuth clockwise from North (0=N, 90=E) in [-180,180], elevation above horizon."""
    if not (np.isfinite(theta_rad) and np.isfinite(phi_rad)):
        return None, None
    elevation = 90.0 - math.degrees(float(theta_rad))      # zenith → elevation
    az = 90.0 - math.degrees(float(phi_rad))               # math (from E, CCW) → from N, CW
    az = ((az + 180.0) % 360.0) - 180.0                    # wrap to [-180, 180]
    return float(az), float(elevation)


def _path_type(order: int, kinds: list[int]) -> str:
    if order == 0:
        return "LOS"
    if any(k == 8 for k in kinds):  # DIFFRACTION
        return "Diffraction"
    if all(k == 1 for k in kinds):  # SPECULAR
        return "Reflection"
    return "NLOS"


def _empty_metrics() -> ChannelMetrics:
    return ChannelMetrics(totalRxPowerDbm=-200.0, losStatus="NLOS", numPaths=0,
                          rmsDelaySpreadNs=0.0, strongestPathPowerDbm=-200.0,
                          strongestPathType="None")


def _channel_metrics(paths: list[PropagationPath]) -> ChannelMetrics:
    if not paths:
        return _empty_metrics()
    powers_lin = np.array([10 ** (p.receivedPowerDbm / 10.0) for p in paths])
    delays = np.array([p.delayNs for p in paths])
    total = float(10.0 * math.log10(max(powers_lin.sum(), 1e-30)))
    mean_delay = float((powers_lin * delays).sum() / powers_lin.sum())
    rms = float(math.sqrt(max((powers_lin * (delays - mean_delay) ** 2).sum() / powers_lin.sum(), 0.0)))
    strongest = max(paths, key=lambda p: p.receivedPowerDbm)
    return ChannelMetrics(
        totalRxPowerDbm=total,
        losStatus="LOS" if any(p.type == "LOS" for p in paths) else "NLOS",
        numPaths=len(paths),
        rmsDelaySpreadNs=rms,
        strongestPathPowerDbm=strongest.receivedPowerDbm,
        strongestPathType=strongest.type,
    )


# Small in-process cache for per-transmitter radio-map layers. Keeping these
# arrays in float32 is substantially smaller than returning every sector's
# values in the initial JSON response. Detailed maps are fetched/exported on
# demand. The cache is intentionally bounded for city-scale Colab sessions.
_RADIO_MAP_CACHE: OrderedDict[str, dict] = OrderedDict()
_RADIO_MAP_CACHE_BYTES = 0
_RADIO_MAP_CACHE_LIMIT = 256 * 1024 * 1024
_RADIO_MAP_CACHE_MAX_ITEMS = 3


def _cache_radio_map(
    centers, path_gain, rss, sinr, tx_metadata, grid_size,
    noise_power_dbm=None, best_rss_tx=None, best_sinr_tx=None,
    best_path_gain_tx=None, map_id=None, scene_context=None,
):
    global _RADIO_MAP_CACHE_BYTES
    arrays = {
        "centers": np.asarray(centers, dtype=np.float32),
        "pathGain": np.asarray(path_gain, dtype=np.float32),
        "rss": np.asarray(rss, dtype=np.float32),
        "sinr": np.asarray(sinr, dtype=np.float32),
    }
    if best_rss_tx is not None:
        arrays["bestRssTx"] = np.asarray(best_rss_tx, dtype=np.int32)
    if best_sinr_tx is not None:
        arrays["bestSinrTx"] = np.asarray(best_sinr_tx, dtype=np.int32)
    if best_path_gain_tx is not None:
        arrays["bestPathGainTx"] = np.asarray(best_path_gain_tx, dtype=np.int32)
    nbytes = sum(a.nbytes for a in arrays.values())
    if nbytes > _RADIO_MAP_CACHE_LIMIT:
        logger.debug("Skipping per-TX radio-map cache: %s bytes exceeds the %s-byte limit", nbytes, _RADIO_MAP_CACHE_LIMIT)
        return None
    key = map_id or uuid.uuid4().hex
    while _RADIO_MAP_CACHE and (
        len(_RADIO_MAP_CACHE) >= _RADIO_MAP_CACHE_MAX_ITEMS
        or _RADIO_MAP_CACHE_BYTES + nbytes > _RADIO_MAP_CACHE_LIMIT
    ):
        _, old = _RADIO_MAP_CACHE.popitem(last=False)
        _RADIO_MAP_CACHE_BYTES -= old["nbytes"]
    _RADIO_MAP_CACHE[key] = {
        **arrays,
        "txMetadata": tx_metadata,
        "gridSize": float(grid_size),
        "noisePowerW": 10.0 ** ((float(noise_power_dbm) - 30.0) / 10.0) if noise_power_dbm is not None else 0.0,
        "sceneContext": scene_context,
        "nbytes": nbytes,
    }
    _RADIO_MAP_CACHE_BYTES += nbytes
    return key


def get_radio_map_tx_data(map_id: str, tx_index: int) -> dict:
    """Return one cached transmitter layer; raises ValueError if expired."""
    cache = _RADIO_MAP_CACHE.get(map_id)
    if cache is None:
        raise ValueError("Radio map data is no longer in the backend cache. Recompute the map and retry.")
    _RADIO_MAP_CACHE.move_to_end(map_id)
    if tx_index < 0 or tx_index >= len(cache["txMetadata"]):
        raise ValueError(f"Invalid transmitter index {tx_index}")
    return {
        "centers": cache["centers"],
        "pathGain": cache["pathGain"][tx_index],
        "rss": cache["rss"][tx_index],
        "rssAll": cache["rss"],
        "sinr": cache["sinr"][tx_index],
        "bestRssTx": cache.get("bestRssTx"),
        "bestSinrTx": cache.get("bestSinrTx"),
        "bestPathGainTx": cache.get("bestPathGainTx"),
        "noisePowerW": cache["noisePowerW"],
        "metadata": cache["txMetadata"][tx_index],
        "gridSize": cache["gridSize"],
    }


def _get_cached_radio_map(map_id: str) -> dict:
    cache = _RADIO_MAP_CACHE.get(map_id)
    if cache is None:
        raise ValueError("Radio map data is no longer in the backend cache. Recompute the map and retry.")
    _RADIO_MAP_CACHE.move_to_end(map_id)
    return cache


def get_radio_map_sector_analysis(map_id: str, tx_index: int) -> dict:
    """Return one detailed sector report, computed from the bounded map cache."""
    cache = _get_cached_radio_map(map_id)
    if tx_index < 0 or tx_index >= len(cache["txMetadata"]):
        raise ValueError(f"Invalid transmitter index {tx_index}")
    return compute_sector_analysis(
        cache["pathGain"], cache["rss"], cache["sinr"], cache["centers"],
        cache["txMetadata"][tx_index], tx_index, cache["noisePowerW"],
        cache["gridSize"] ** 2, cache.get("bestRssTx", np.argmax(cache["rss"], axis=0)),
        cache.get("bestSinrTx"), cache.get("bestPathGainTx"),
    )


def get_radio_map_interference_matrix(map_id: str, top_k: int = 3) -> dict:
    """Return the top-K dominant interferer matrix from the cached native RSS."""
    cache = _get_cached_radio_map(map_id)
    return compute_dominant_interferer_matrix(
        cache["rss"], cache["txMetadata"], cache.get("bestRssTx"),
        cache["noisePowerW"], top_k=top_k,
    )


def get_radio_map_sample_cells(
    map_id: str,
    tx_index: int,
    criterion: str = "weak_sinr",
    limit: int = 200,
    association_scope: str = "all",
    selection_mode: str = "spatially_distributed",
) -> list[dict]:
    """Return deterministic selected grid cells for export/follow-up analysis."""
    cache = _get_cached_radio_map(map_id)
    return sample_sector_cells(
        cache["centers"], cache["rss"], cache["sinr"], tx_index,
        cache["noisePowerW"], criterion=criterion, limit=limit,
        association_scope=association_scope, selection_mode=selection_mode,
    )



MAX_CHANNEL_ANALYSIS_PAIRS = 96
MAX_CHANNEL_ANALYSIS_CFR_COMPLEX_SAMPLES = 8_388_608


def _estimate_channel_cfr_samples(
    pair_count: int, n_rx_ant: int, n_tx_ant: int, num_subcarriers: int,
) -> int:
    """Estimate complex CFR elements allocated for the requested Tx/Rx batch."""
    return (int(pair_count) * int(n_rx_ant) * int(n_tx_ant)
            * int(num_subcarriers))


def _channel_k_factor(paths: list[PropagationPath]) -> tuple[float | None, str | None]:
    """Compute K = LOS power / aggregate non-LOS power in dB.

    K is intentionally undefined for an NLOS-only channel or when the channel
    has no measurable scattered component. The caller can display the reason
    instead of inventing a finite value for an infinite/undefined ratio.
    """
    los_power = sum(10.0 ** (p.receivedPowerDbm / 10.0)
                    for p in paths if p.type == "LOS" and math.isfinite(p.receivedPowerDbm))
    nlos_power = sum(10.0 ** (p.receivedPowerDbm / 10.0)
                     for p in paths if p.type != "LOS" and math.isfinite(p.receivedPowerDbm))
    if los_power <= 0.0:
        return None, "No valid LOS component was detected."
    if nlos_power <= 0.0:
        return None, "No valid NLOS/scattered component was detected; K tends to +infinity."
    return float(10.0 * math.log10(los_power / nlos_power)), None


def _channel_profiles_for_pair(
    a_native: np.ndarray,
    tau_native: np.ndarray,
    h_native: np.ndarray,
    frequencies_hz: np.ndarray,
    valid_native: np.ndarray,
    rx_index: int,
    tx_index: int,
    tx_power_dbm: float,
    n_rx_ant: int,
    n_tx_ant: int,
    paths_to_return: int,
) -> tuple[list[dict], dict]:
    """Reduce Sionna's native six-axis CIR/CFR for one (Rx, Tx) link.

    CIR values remain path-resolved rather than coherently merging paths into
    arbitrary delay bins. The transmit array uses the same unit-norm uniform
    precoder as the path KPI calculation. Physical Rx-port powers are summed.
    A scalar CFR phase is exposed only for a single Rx port; a port-summed MIMO
    magnitude has no unique phase reference.
    """
    a = np.asarray(a_native)
    tau = _notebook_tau_shape(a, tau_native)
    h = np.asarray(h_native)
    if a.ndim != 6:
        raise ValueError(f"Unexpected native CIR shape {a.shape}; expected [rx,rx_ant,tx,tx_ant,path,time]")
    if h.ndim != 6:
        raise ValueError(f"Unexpected native CFR shape {h.shape}; expected [rx,rx_ant,tx,tx_ant,time,subcarrier]")
    if a.shape[0] <= rx_index or a.shape[2] <= tx_index:
        raise ValueError("Native CIR device axes do not match the selected channel link")
    if h.shape[:4] != (a.shape[0], a.shape[1], a.shape[2], a.shape[3]):
        raise ValueError(f"Native CFR antenna/device axes {h.shape[:4]} do not match CIR axes {a.shape[:4]}")
    if h.shape[-1] != len(frequencies_hz):
        raise ValueError(f"Native CFR subcarrier axis {h.shape[-1]} does not match frequency grid {len(frequencies_hz)}")

    # Sionna native layout: [rx, rx_ant, tx, tx_ant, path, time].
    link_a = a[rx_index, :, tx_index, :, :, :]
    precoded_a = np.sum(link_a, axis=1) / math.sqrt(max(1, int(n_tx_ant)))
    # [rx_ant, path, time] -> first available CIR time snapshot.
    coeff = precoded_a[:, :, 0]
    path_power = np.sum(np.abs(coeff) ** 2, axis=0)
    link_tau = tau[rx_index, 0, tx_index, 0, :]
    valid = np.asarray(valid_native[rx_index, tx_index], dtype=bool).reshape(-1)
    taps: list[dict] = []
    for path_index in range(min(len(valid), len(link_tau), len(path_power))):
        if not valid[path_index] or not np.isfinite(link_tau[path_index]):
            continue
        gain = float(path_power[path_index])
        tap_dbm = (float(tx_power_dbm) + 10.0 * math.log10(gain)
                   if gain > 0.0 and math.isfinite(gain) else None)
        phase = float(np.angle(coeff[0, path_index])) if n_rx_ant == 1 else None
        taps.append({
            "pathIndex": int(path_index),
            "delayNs": float(link_tau[path_index] * 1e9),
            "receivedPowerDbm": tap_dbm,
            "phaseDeg": float(math.degrees(phase)) if phase is not None else None,
        })
    taps.sort(key=lambda item: (item["receivedPowerDbm"] is None,
                                -(item["receivedPowerDbm"] or -1e9)))
    taps = taps[:max(1, int(paths_to_return))]

    # Sionna native layout: [rx, rx_ant, tx, tx_ant, time, subcarrier].
    link_h = h[rx_index, :, tx_index, :, :, :]
    precoded_h = np.sum(link_h, axis=1) / math.sqrt(max(1, int(n_tx_ant)))
    # Sum physical receive-port powers; average only over explicit time snapshots.
    gain_per_sc = np.mean(np.sum(np.abs(precoded_h) ** 2, axis=0), axis=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        magnitude_db = 10.0 * np.log10(gain_per_sc)
    magnitude_db = [float(v) if np.isfinite(v) else None for v in magnitude_db]
    # A complex scalar phase is physically interpretable only for one Rx port.
    if n_rx_ant == 1:
        phase_deg = np.degrees(np.angle(precoded_h[0, 0, :])).astype(float).tolist()
        phase_deg = [float(v) if math.isfinite(v) else None for v in phase_deg]
        phase_note = "Single receive port: phase is the native complex CFR phase after unit-norm uniform Tx precoding."
    else:
        phase_deg = None
        phase_note = "Phase omitted: receive-port power aggregation produces a MIMO magnitude without a unique scalar phase."
    cfr = {
        "frequencyOffsetHz": [float(v) for v in np.asarray(frequencies_hz).reshape(-1)],
        "magnitudeDb": magnitude_db,
        "receivedPowerDbm": [
            float(tx_power_dbm + value) if value is not None else None
            for value in magnitude_db
        ],
        "phaseDeg": phase_deg,
        "phaseAvailable": phase_deg is not None,
        "phaseNote": phase_note,
        "numRxPorts": int(n_rx_ant),
        "numTxPorts": int(n_tx_ant),
    }
    return taps, cfr


def solve_radio_map_channel_analysis(map_id: str, req: ChannelAnalysisRequest) -> dict:
    """Run one batched PathSolver pass at selected cached radio-map cells."""
    import time
    from sionna.rt import subcarrier_frequencies

    started = time.perf_counter()
    cache = _get_cached_radio_map(map_id)
    context = cache.get("sceneContext")
    if not context:
        raise ValueError("This radio map has no saved scene context for PathSolver replay. Recompute the radio map with the current application version.")
    centers = np.asarray(cache["centers"], dtype=np.float64)
    cell_indices = [int(i) for i in req.cellIndices]
    if any(i >= len(centers) for i in cell_indices):
        raise ValueError(f"Selected cell index is outside the cached radio map (0..{len(centers) - 1})")

    txs: list[Transmitter] = list(context["transmitters"])
    if not txs or len(txs) != len(cache["txMetadata"]):
        raise ValueError("Cached transmitter configuration is incomplete; recompute the radio map")
    if req.txMode == "selected":
        if req.txIndex is None or req.txIndex >= len(txs):
            raise ValueError(f"Invalid selected transmitter index {req.txIndex}")

    rss = np.asarray(cache["rss"], dtype=np.float64)
    best_rss = np.asarray(cache.get("bestRssTx", np.argmax(rss, axis=0)), dtype=np.int32)
    roles_by_cell: dict[int, dict[int, str]] = {}
    selected_tx_indices: set[int] = set()
    for cell_index in cell_indices:
        roles: dict[int, str] = {}
        if req.txMode in ("serving", "serving_and_interferer"):
            serving = int(best_rss[cell_index]) if cell_index < len(best_rss) else -1
            if 0 <= serving < len(txs):
                roles[serving] = "serving"
            if req.txMode == "serving_and_interferer" and len(txs) > 1:
                competitor = np.where(np.isfinite(rss[:, cell_index]) & (rss[:, cell_index] > 0), rss[:, cell_index], 0.0).copy()
                if 0 <= serving < len(txs):
                    competitor[serving] = 0.0
                interferer = int(np.argmax(competitor))
                if competitor[interferer] > 0.0:
                    roles[interferer] = "dominant_interferer"
        elif req.txMode == "selected":
            roles[int(req.txIndex)] = "selected"
        else:  # all co-channel transmitters
            roles = {index: "co_channel" for index in range(len(txs))}
        roles_by_cell[cell_index] = roles
        selected_tx_indices.update(roles.keys())

    if not selected_tx_indices:
        raise ValueError("The selected radio-map cells have no associated transmitter to analyse")
    # The existing batching routine traces the Cartesian product of selected Tx
    # and selected Rx points. Bound it before GPU allocation.
    tx_indices = sorted(selected_tx_indices)
    pair_count = len(tx_indices) * len(cell_indices)
    if pair_count > MAX_CHANNEL_ANALYSIS_PAIRS:
        raise ValueError(
            f"Selection requires {pair_count} Tx–Rx pairs; limit is {MAX_CHANNEL_ANALYSIS_PAIRS}. Reduce locations or choose fewer sectors."
        )

    original_size = tuple(int(v) for v in txs[0].antennaArraySize)
    if any(tuple(int(v) for v in txs[i].antennaArraySize) != original_size for i in tx_indices):
        raise ValueError("All selected transmitters must share the same antennaArraySize")
    options: SolverOptions = context["options"]
    scene = build_scene(context["buildings"], float(context["frequencyGhz"]), context["materials"])
    n_tx_ant = _set_tx_array(scene, original_size, options)
    n_rx_ant = _set_planar_array(scene, "rx", req.rxArraySize, options.rxPattern, options.rxPolarization)
    estimated_cfr_samples = _estimate_channel_cfr_samples(
        pair_count, n_rx_ant, n_tx_ant, int(req.numSubcarriers),
    )
    if estimated_cfr_samples > MAX_CHANNEL_ANALYSIS_CFR_COMPLEX_SAMPLES:
        raise ValueError(
            f"Requested Tx/Rx arrays and subcarrier grid require an estimated "
            f"{estimated_cfr_samples:,} complex CFR values; limit is "
            f"{MAX_CHANNEL_ANALYSIS_CFR_COMPLEX_SAMPLES:,}. Reduce selected "
            f"locations, array size, or CFR subcarriers."
        )

    tx_specs: list[_TxSpec] = []
    for original_index in tx_indices:
        tx = txs[original_index]
        tx_pos = [float(tx.enu.x), float(tx.enu.y),
                  _device_z(tx.enu, tx.height, context["buildings"], getattr(tx, "heightReference", None))]
        tx_specs.append(_TxSpec(
            pos=tx_pos,
            beam=_beam_target(tx_pos, tx.beamsteeringAzimuth, tx.beamsteeringElevation),
            power_dbm=float(tx.powerDbm), id=tx.id, name=tx.name,
        ))
    rx_positions = [[float(centers[i, 0]), float(centers[i, 1]), float(centers[i, 2])] for i in cell_indices]
    rx_velocities = [[0.0, 0.0, 0.0] for _ in rx_positions]

    batch_result = _solve_batched(
        scene, tx_specs, rx_positions, rx_velocities, n_tx_ant,
        max_depth=int(context["maxDepth"]), opts=options, return_native=True,
    )
    per_rx, native_paths = batch_result
    # Use native PathSolver APIs on this same single dispatch, not a second solve.
    a_native, tau_native = native_paths.cir(normalize_delays=False, out_type="numpy")
    frequency_grid = subcarrier_frequencies(
        int(req.numSubcarriers), float(req.subcarrierSpacingHz)
    )
    frequencies = np.asarray(to_numpy(frequency_grid), dtype=np.float64).reshape(-1)
    h_native = native_paths.cfr(
        frequencies=frequency_grid,
        normalize_delays=False,
        out_type="numpy",
    )
    valid_native = to_numpy(native_paths.valid).astype(bool)
    if valid_native.ndim != 3:
        raise ValueError(f"Unexpected PathSolver valid tensor shape {valid_native.shape}; expected [rx,tx,path]")

    locations: list[dict] = []
    tx_local_by_original = {original: local for local, original in enumerate(tx_indices)}
    for rx_index, cell_index in enumerate(cell_indices):
        roles = roles_by_cell[cell_index]
        links: list[dict] = []
        for original_tx_index, role in roles.items():
            local_tx_index = tx_local_by_original[original_tx_index]
            paths, max_doppler = per_rx[rx_index][local_tx_index]
            metrics = _channel_metrics(paths)
            k_factor, k_reason = _channel_k_factor(paths)
            taps, cfr = _channel_profiles_for_pair(
                np.asarray(a_native), np.asarray(tau_native), np.asarray(h_native),
                frequencies, valid_native, rx_index, local_tx_index,
                float(txs[original_tx_index].powerDbm), n_rx_ant, n_tx_ant,
                int(req.pathsToReturn),
            )
            links.append({
                "txIndex": int(original_tx_index),
                "txId": txs[original_tx_index].id,
                "txName": txs[original_tx_index].name,
                "role": role,
                "channelMetrics": metrics,
                "kFactorDb": k_factor,
                "kFactorNote": k_reason,
                "maxDopplerHz": float(max_doppler),
                "cirTaps": taps,
                "cfr": cfr,
                "paths": paths[:int(req.pathsToReturn)],
            })
        serving_index = int(best_rss[cell_index]) if cell_index < len(best_rss) else -1
        competitor = np.where(np.isfinite(rss[:, cell_index]) & (rss[:, cell_index] > 0), rss[:, cell_index], 0.0).copy()
        if 0 <= serving_index < len(txs):
            competitor[serving_index] = 0.0
        interferer_index = int(np.argmax(competitor)) if competitor.size else -1
        if not competitor.size or competitor[interferer_index] <= 0:
            interferer_index = -1
        locations.append({
            "cellIndex": int(cell_index),
            "positionEnuM": {"x": float(centers[cell_index, 0]), "y": float(centers[cell_index, 1]), "z": float(centers[cell_index, 2])},
            "radioMap": {
                "servingTxIndex": serving_index if serving_index >= 0 else None,
                "servingTxName": txs[serving_index].name if 0 <= serving_index < len(txs) else None,
                "rssDbm": float(10.0 * math.log10(rss[serving_index, cell_index]) + 30.0) if 0 <= serving_index < len(txs) and rss[serving_index, cell_index] > 0 else None,
                "topInterfererTxIndex": interferer_index if interferer_index >= 0 else None,
            },
            "links": links,
        })

    return {
        "mapId": map_id,
        "frequencyGhz": float(context["frequencyGhz"]),
        "maxDepth": int(context["maxDepth"]),
        "numSubcarriers": int(req.numSubcarriers),
        "subcarrierSpacingHz": float(req.subcarrierSpacingHz),
        "rxArraySize": list(req.rxArraySize),
        "numRxPorts": int(n_rx_ant),
        "numTxPorts": int(n_tx_ant),
        "execution": {
            "strategy": "single_batched_pathsolver_dispatch",
            "pathSolverDispatches": 1,
            "tracedTxRxPairs": int(pair_count),
            "returnedLinks": int(sum(len(loc["links"]) for loc in locations)),
            "estimatedCfrComplexSamples": int(estimated_cfr_samples),
            "solveTimeMs": float((time.perf_counter() - started) * 1000.0),
            "samplesPerSource": int(options.pathSamplesPerSource),
            "seed": int(options.pathSeed),
        },
        "locations": locations,
        "interpretation": {
            "los": "LOS is reported only when PathSolver returns a valid zero-interaction direct path; the radio-map LOS field remains unknown because RadioMapSolver does not expose it per cell.",
            "kFactor": "K = total LOS path power / total NLOS path power. It is undefined for NLOS-only links or when no scattered component is returned.",
            "cir": "Path-resolved coefficients and delays from paths.cir(normalize_delays=False); plotted tap power uses unit-norm uniform Tx precoding and sums physical Rx-port powers.",
            "cfr": "Native paths.cfr() on the requested subcarrier grid. The magnitude is the receive-port power sum; a scalar phase is available only for a single Rx port.",
            "angles": "AoA/AoD are returned per path only when the installed Sionna Paths object exposes finite theta/phi fields.",
        },
    }

def _finite_float(value):
    value = float(value)
    return value if math.isfinite(value) else None


def _default_threshold(metric: str, given: float | None) -> float:
    """Served threshold: -90 dBm for received power, 0 dB for SINR (unless given)."""
    if given is not None:
        return float(given)
    return -90.0 if metric == "power" else 0.0


def _coverage_stats(values: np.ndarray, metric: str, threshold: float) -> CoverageStats:
    """Coverage stats over the finite metric values of reachable cells."""
    unit = "dBm" if metric == "power" else "dB"
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return CoverageStats(metric=metric, unit=unit, thresholdDb=float(threshold),
                             servedPercent=0.0, p5=0.0, p50=0.0, p95=0.0,
                             minVal=0.0, maxVal=0.0)
    served = float(100.0 * np.mean(finite >= threshold))
    p5, p50, p95 = (float(np.percentile(finite, q)) for q in (5, 50, 95))
    return CoverageStats(metric=metric, unit=unit, thresholdDb=float(threshold),
                         servedPercent=served, p5=p5, p50=p50, p95=p95,
                         minVal=float(finite.min()), maxVal=float(finite.max()))


def _to_tx_cells(arr, num_tx: int, n_cells: int) -> np.ndarray:
    """Normalize a radio-map metric tensor to shape (num_tx, n_cells)."""
    a = np.asarray(to_numpy(arr), dtype=float)
    if a.size == num_tx * n_cells:
        return a.reshape(num_tx, n_cells)
    if a.size == n_cells:
        return a.reshape(1, n_cells)
    return a.reshape(num_tx, -1)[:, :n_cells]


def solve_radiomap(req: RadioMapRequest) -> RadioMapGrid:
    """Compute native Sionna radio maps and research-oriented derived KPIs.

    Native inputs: RadioMap.path_gain, RadioMap.rss, RadioMap.sinr.
    Derived outputs: interference power, SIR, INR, dominance margin, coverage
    area/probability, percentiles, CDF and per-transmitter summaries.
    """
    import time
    from sionna.rt import RadioMapSolver

    total_started = time.perf_counter()
    txs = req.transmitters()
    known_carriers = sorted({round(float(t.carrierFrequencyGhz), 6) for t in txs if t.carrierFrequencyGhz is not None})
    if len(known_carriers) > 1:
        raise ValueError(f"Radio-map solve cannot mix different carrier frequencies: {known_carriers} GHz")
    if known_carriers and abs(known_carriers[0] - float(req.freqGhz)) > 0.001:
        raise ValueError(f"Configured carrier {req.freqGhz} GHz does not match imported transmitter carrier {known_carriers[0]} GHz")
    n_buildings = sum(1 for b in req.buildings if b.category == "building" and len(b.enuPoints) >= 3)
    logger.debug(
        "Starting radio-map solve: tx=%s buildings=%s/%s cell=%.3fm samples_per_tx=%s max_depth=%s metric=%s",
        len(txs), n_buildings, len(req.buildings), float(req.gridSize),
        int(req.samplesPerTx), int(req.maxDepth), req.metric,
    )

    stage_started = time.perf_counter()
    scene = build_scene(req.buildings, req.freqGhz, req.materials)
    logger.debug("Radio-map scene ready in %.2f seconds", time.perf_counter() - stage_started)

    # Set the thermal noise model used by Sionna's SINR calculation.
    # Keep the effective temperature as a plain Python float for analytics.
    # Sionna/Dr.Jit may expose ``scene.temperature`` back as a
    # drjit.cuda.ad.Float, which intentionally cannot be passed to float()
    # directly (it is a JIT array and conversion would require an explicit
    # device-to-host transfer). Reuse the exact scalar assigned to the scene
    # instead of reading the Dr.Jit property back.
    scene.bandwidth = float(req.bandwidthHz)
    noise_temperature_k = 293.0 * (10.0 ** (float(req.noiseFigureDb) / 10.0))
    scene.temperature = noise_temperature_k

    xs = [t.enu.x for t in txs]
    ys = [t.enu.y for t in txs]
    for b in req.buildings:
        for p in b.enuPoints:
            xs.append(p.x)
            ys.append(p.y)
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    size_x = max(maxx - minx, 100.0) + 60.0
    size_y = max(maxy - miny, 100.0) + 60.0
    cell = max(float(req.gridSize), 1.0)
    cells_x = int(math.ceil(size_x / cell))
    cells_y = int(math.ceil(size_y / cell))
    estimated_cells = cells_x * cells_y
    logger.debug(
        "Radio-map grid: %sx%s estimated_cells=%s extent=%.1fx%.1fm",
        cells_x, cells_y, estimated_cells, size_x, size_y,
    )

    array_sizes = [tuple(int(v) for v in t.antennaArraySize) for t in txs]
    if any(size != array_sizes[0] for size in array_sizes):
        raise ValueError("Radio maps with multiple transmitters require matching antennaArraySize")
    _set_tx_array(scene, txs[0].antennaArraySize, req.options)

    _clear_devices(scene)
    for i, t in enumerate(txs):
        tz = _device_z(t.enu, t.height, req.buildings, getattr(t, "heightReference", None))
        pos = [float(t.enu.x), float(t.enu.y), tz]
        beam = _beam_target(pos, t.beamsteeringAzimuth, t.beamsteeringElevation)
        _place_tx(scene, f"tx_rm_{i}", pos, beam, power_dbm=t.powerDbm)

    solver_started = time.perf_counter()
    logger.debug("RadioMapSolver dispatch started")
    rm = RadioMapSolver()(
        scene,
        center=[cx, cy, float(req.gridHeight)],
        orientation=[0.0, 0.0, 0.0],
        size=[size_x, size_y],
        cell_size=[cell, cell],
        samples_per_tx=int(req.samplesPerTx),
        max_depth=int(max(0, req.maxDepth)),
        los=req.options.los,
        specular_reflection=req.options.specularReflection,
        diffuse_reflection=req.options.diffuseReflection,
        refraction=req.options.refraction,
        diffraction=req.options.diffraction,
        edge_diffraction=req.options.edgeDiffraction,
        seed=int(req.seed),
    )
    logger.debug("RadioMapSolver returned in %.2f seconds", time.perf_counter() - solver_started)

    transfer_started = time.perf_counter()
    centers = np.asarray(to_numpy(rm.cell_centers), dtype=float).reshape(-1, 3)
    n_cells = centers.shape[0]
    num_tx = len(txs)
    path_gain = _to_tx_cells(rm.path_gain, num_tx, n_cells)  # native Sionna, linear gain
    rss = _to_tx_cells(rm.rss, num_tx, n_cells)              # native Sionna, W
    sinr = _to_tx_cells(rm.sinr, num_tx, n_cells)            # native Sionna, linear ratio
    logger.debug(
        "Radio-map device-to-host transfer complete: cells=%s tx=%s seconds=%.2f",
        n_cells, num_tx, time.perf_counter() - transfer_started,
    )

    post_started = time.perf_counter()
    metadata = [
        {
            "id": t.id, "name": t.name, "site": t.site,
            "frequencyBand": t.frequencyBand, "powerDbm": float(t.powerDbm),
            "transmitterLabel": t.transmitterLabel,
            "antennaModel": t.antennaModel,
            "carrierFrequencyGhz": t.carrierFrequencyGhz,
            "positionEnuM": [float(t.enu.x), float(t.enu.y), _device_z(t.enu, t.height, req.buildings, getattr(t, "heightReference", None))],
            "heightReference": t.heightReference,
        }
        for t in txs
    ]
    analytics = compute_radio_map_analytics(
        path_gain_w=path_gain,
        rss_w=rss,
        sinr_linear=sinr,
        tx_metadata=metadata,
        bandwidth_hz=float(req.bandwidthHz),
        temperature_k=noise_temperature_k,
        cell_area_m2=cell * cell,
        metric=req.metric,
        threshold=req.coverageThresholdDb,
        rss_threshold_dbm=float(req.rssCoverageThresholdDb),
        sinr_threshold_db=float(req.sinrCoverageThresholdDb),
    )
    map_id = _cache_radio_map(
        centers, path_gain, rss, sinr, metadata, cell,
        noise_power_dbm=analytics["noisePowerDbm"],
        best_rss_tx=analytics["bestRssTx"],
        best_sinr_tx=analytics["bestSinrTx"],
        best_path_gain_tx=analytics["bestPathGainTx"],
        scene_context={
            "buildings": req.buildings,
            "transmitters": txs,
            "frequencyGhz": float(req.freqGhz),
            "maxDepth": int(req.maxDepth),
            "options": req.options,
            "materials": req.materials,
        },
    )

    cells: list[RadioMapCell] = []
    for k in range(n_cells):
        pos = centers[k]
        best_tx = int(analytics["bestRssTx"][k])
        cells.append(RadioMapCell(
            x=float(pos[0]), y=float(pos[1]), z=float(pos[2]),
            powerDbm=_finite_float(analytics["bestRssDbm"][k]) if _finite_float(analytics["bestRssDbm"][k]) is not None else -250.0,
            isLos=None,
            sinr=_finite_float(analytics["bestSinrDb"][k]),
            servingTx=best_tx if math.isfinite(float(analytics["bestRssDbm"][k])) else None,
            bestSinrTx=int(analytics["bestSinrTx"][k]) if math.isfinite(float(analytics["bestSinrMaxDb"][k])) else None,
            bestSinrDb=_finite_float(analytics["bestSinrMaxDb"][k]),
            bestPathGainTx=int(analytics["bestPathGainTx"][k]) if math.isfinite(float(analytics["bestPathGainDb"][k])) else None,
            pathGainDb=_finite_float(analytics["bestPathGainDb"][k]),
            effectivePathLossDb=_finite_float(analytics["bestPathLossDb"][k]),
            competingSectorCount=int(analytics["competingSectorCount"][k]),
            interferencePowerDbm=_finite_float(analytics["interferenceDbm"][k]),
            sirDb=_finite_float(analytics["sirDb"][k]),
            inrDb=_finite_float(analytics["inrDb"][k]),
            dominanceMarginDb=_finite_float(analytics["dominanceMarginDb"][k]),
            topInterfererTx=int(analytics["topInterfererTx"][k]) if int(analytics["topInterfererTx"][k]) >= 0 else None,
            topInterfererPowerDbm=_finite_float(analytics["topInterfererPowerDbm"][k]),
            topInterferenceSharePercent=_finite_float(analytics["topInterferenceSharePercent"][k]),
            metricValue=_finite_float(analytics["metricValues"][k]),
        ))

    stats_payload = analytics["stats"]
    response = RadioMapGrid(
        cells=cells,
        minX=float(minx), maxX=float(maxx), minY=float(miny), maxY=float(maxy),
        gridSize=cell, heightOffset=float(req.gridHeight),
        metric=req.metric, unit=METRIC_UNITS[req.metric],
        stats=stats_payload, txStats=analytics["txStats"], siteStats=analytics["siteStats"],
        associationStats={
            "rss": [{"txIndex": int(x["txIndex"]), "txId": x["txId"], "txName": x["txName"], "cells": int(x["servingCellCount"]), "percentOfAllCells": float(100.0 * x["servingCellCount"] / max(n_cells, 1))} for x in analytics["txStats"]],
            "sinr": [{"txIndex": int(x["txIndex"]), "txId": x["txId"], "txName": x["txName"], "cells": int(x["sinrAssociationCellCount"]), "percentOfAllCells": float(100.0 * x["sinrAssociationCellCount"] / max(n_cells, 1))} for x in analytics["txStats"]],
            "pathGain": [{"txIndex": int(x["txIndex"]), "txId": x["txId"], "txName": x["txName"], "cells": int(x["pathGainAssociationCellCount"]), "percentOfAllCells": float(100.0 * x["pathGainAssociationCellCount"] / max(n_cells, 1))} for x in analytics["txStats"]],
            "unassociatedRssCells": int(np.sum(analytics["bestRssTx"] < 0)),
            "unassociatedSinrCells": int(np.sum(analytics["bestSinrTx"] < 0)),
            "unassociatedPathGainCells": int(np.sum(analytics["bestPathGainTx"] < 0)),
            "method": "Per-cell argmax over Sionna native per-transmitter RSS, SINR, and path_gain arrays; -1 represents no finite positive metric.",
        },
        mapId=map_id, noisePowerDbm=analytics["noisePowerDbm"],
        simulationConfig={
            "frequencyGhz": float(req.freqGhz),
            "bandwidthHz": float(req.bandwidthHz),
            "noiseFigureDb": float(req.noiseFigureDb),
            "maxDepth": int(req.maxDepth),
            "los": bool(req.options.los),
            "specularReflection": bool(req.options.specularReflection),
            "diffuseReflection": bool(req.options.diffuseReflection),
            "refraction": bool(req.options.refraction),
            "diffraction": bool(req.options.diffraction),
            "edgeDiffraction": bool(req.options.edgeDiffraction),
            "txPattern": req.options.txPattern,
            "txPolarization": req.options.txPolarization,
            "txArraySize": list(array_sizes[0]),
            "metric": req.metric,
            "coverageThresholdDb": float(stats_payload["thresholdDb"]),
            "coverageThresholdComparison": stats_payload["thresholdComparison"],
            "rssCoverageThresholdDbm": float(req.rssCoverageThresholdDb),
            "sinrCoverageThresholdDb": float(req.sinrCoverageThresholdDb),
            "cellSizeM": cell,
            "measurementHeightM": float(req.gridHeight),
            "transmitters": [
                {
                    "id": t.id,
                    "name": t.name,
                    "site": t.site,
                    "transmitterLabel": t.transmitterLabel,
                    "frequencyBand": t.frequencyBand,
                    "carrierFrequencyGhz": t.carrierFrequencyGhz,
                    "latitude": t.latitude,
                    "longitude": t.longitude,
                    "positionEnuM": [float(t.enu.x), float(t.enu.y), _device_z(t.enu, t.height, req.buildings, getattr(t, "heightReference", None))],
                    "heightM": float(t.height),
                    "heightReference": t.heightReference,
                    "powerDbm": float(t.powerDbm),
                    "sourcePowerDbm": t.sourcePowerDbm,
                    "powerReference": t.powerReference,
                    "antennaGainDbi": t.antennaGainDbi,
                    "antennaModel": t.antennaModel,
                    "antennaArraySize": list(t.antennaArraySize),
                    "azimuthDeg": float(t.beamsteeringAzimuth),
                    "elevationDeg": float(t.beamsteeringElevation),
                    "mechanicalDowntiltDeg": t.mechanicalDowntiltDeg,
                    "electricalDowntiltDeg": t.electricalDowntiltDeg,
                }
                for t in txs
            ],
            "materials": [m.model_dump() for m in req.materials],
        },
        samplesPerTx=int(req.samplesPerTx), seed=int(req.seed),
    )
    logger.debug(
        "Radio-map response ready: cells=%s tx=%s cached=%s postprocess_seconds=%.2f total_seconds=%.2f",
        n_cells, num_tx, bool(map_id),
        time.perf_counter() - post_started, time.perf_counter() - total_started,
    )
    return response
