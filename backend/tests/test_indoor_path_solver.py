from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

import backend.indoor_scene_runtime as indoor_runtime
import backend.solver as solver_module
from backend.models import IndoorPathMatrixSolveRequest, IndoorPathSolveRequest, Receiver, SolverOptions, Transmitter


def _tx():
    return Transmitter(
        id="tx-1", name="Classroom TX", enu={"x": 0, "y": 0, "z": 0},
        powerDbm=27.0, antennaArraySize=(1, 1), beamSteeringFrame="device_local",
        scenePosition=(1.0, 2.0, 1.4), sceneOrientation=(0, 0, 0, 1),
        sceneSessionId="session-1",
    )


def _rx():
    return Receiver(
        id="rx-1", name="Classroom RX", enu={"x": 0, "y": 0, "z": 0},
        antennaArraySize=(1, 1), scenePosition=(2.0, 1.0, 1.2),
        sceneOrientation=(0, 0, 0, 1), sceneSessionId="session-1",
    )


class FakeAntennaArray:
    """Strict stand-in for Sionna's AntennaArray base class."""


class FakeArray(FakeAntennaArray):
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.num_ant = int(kwargs.get("num_cols", 1) * kwargs.get("num_rows", 1))


class FakeTx:
    def __init__(self, *, name, position, orientation, power_dbm):
        self.name, self.position, self.orientation, self.power_dbm = name, tuple(position), tuple(orientation), power_dbm


class FakeRx:
    def __init__(self, *, name, position, orientation):
        self.name, self.position, self.orientation = name, tuple(position), tuple(orientation)


class FakeDrJitScalar:
    """Mimic a vectorized Dr.Jit scalar that cannot be unboxed with float()."""

    def __init__(self, value):
        self.value = value

    def numpy(self):
        return np.asarray([self.value], dtype=np.float32)

    def __float__(self):
        raise TypeError(
            "float() argument must be a string or a real number, not 'drjit.cuda.ad.Float'"
        )


class FakeScene:
    def __init__(self):
        self.transmitters = {}
        self.receivers = {}
        self._tx_array = None
        self._rx_array = None
        self.frequency = 28e9

    @property
    def tx_array(self):
        return self._tx_array

    @tx_array.setter
    def tx_array(self, value):
        if not isinstance(value, FakeAntennaArray):
            raise TypeError("`array` must be an instance of ``AntennaArray``")
        self._tx_array = value

    @property
    def rx_array(self):
        return self._rx_array

    @rx_array.setter
    def rx_array(self, value):
        if not isinstance(value, FakeAntennaArray):
            raise TypeError("`array` must be an instance of ``AntennaArray``")
        self._rx_array = value

    def add(self, items):
        for item in items if isinstance(items, (list, tuple)) else [items]:
            (self.transmitters if isinstance(item, FakeTx) else self.receivers)[item.name] = item

    def remove(self, name):
        self.transmitters.pop(name, None)
        self.receivers.pop(name, None)


def _native_paths(*, geometry_shape="synthetic", valid=(True, True)):
    """Build a Paths-like result in the documented synthetic-array layouts."""
    valid = np.asarray(valid, dtype=bool)
    num_paths = valid.size
    tau_3d = np.asarray([[[10e-9 + i * 2e-9 for i in range(num_paths)]]], dtype=np.float64)
    doppler_3d = np.zeros((1, 1, num_paths), dtype=np.float64)
    theta_3d = np.full((1, 1, num_paths), np.pi / 2, dtype=np.float64)
    phi_3d = np.zeros((1, 1, num_paths), dtype=np.float64)
    interactions_4d = np.zeros((1, 1, 1, num_paths), dtype=np.uint32)
    vertices_5d = np.zeros((1, 1, 1, num_paths, 3), dtype=np.float64)
    if num_paths > 1:
        interactions_4d[0, 0, 0, 1] = 1  # one specular reflection
        vertices_5d[0, 0, 0, 1] = [1.5, 1.5, 1.3]

    if geometry_shape == "synthetic":
        # Sionna 2.0.1 synthetic-array Paths keeps geometry on [rx, tx, path]
        # device-pair axes. Coefficients below still retain physical antenna
        # ports, while the geometry/valid arrays do not.
        valid_data = valid.reshape(1, 1, num_paths)
        interactions_data = interactions_4d
        vertices_data = vertices_5d
        tau_data, doppler_data = tau_3d, doppler_3d
        theta_data, phi_data = theta_3d, phi_3d
    else:
        # Compatibility contract for expanded singleton antenna axes exposed
        # by some downstream tensor wrappers.
        valid_data = valid.reshape(1, 1, 1, 1, num_paths)
        interactions_data = interactions_4d.reshape(1, 1, 1, 1, 1, num_paths)
        vertices_data = vertices_5d.reshape(1, 1, 1, 1, 1, num_paths, 3)
        tau_data = tau_3d.reshape(1, 1, 1, 1, num_paths)
        doppler_data = doppler_3d.reshape(1, 1, 1, 1, num_paths)
        theta_data = theta_3d.reshape(1, 1, 1, 1, num_paths)
        phi_data = phi_3d.reshape(1, 1, 1, 1, num_paths)

    real = np.asarray([[[[[1e-3 + i * 2e-4 for i in range(num_paths)]]]]], dtype=np.float64)
    imag = np.zeros_like(real)
    return SimpleNamespace(
        valid=valid_data,
        interactions=interactions_data,
        vertices=vertices_data,
        tau=tau_data,
        doppler=doppler_data,
        theta_t=theta_data,
        phi_t=phi_data,
        theta_r=theta_data,
        phi_r=phi_data,
        a=(real, imag),
    )


@pytest.fixture
def active_runtime(monkeypatch):
    scene = FakeScene()
    active = indoor_runtime.ActiveIndoorScene(
        session_id="session-1", scene=scene, carrier_frequency_ghz=28.0,
        material_mappings={"wall": "concrete"},
        summary={"activation": "active", "sionnaVersion": "2.0.1", "mitsubaVariant": "cuda_ad_mono_polarized"},
        activated_at="now", canonical_xml_path="/tmp/indoor.xml",
        device_names={"tx": [], "rx": []},
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(
        indoor_runtime, "_runtime_imports",
        lambda: (object(), None, {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}}, object, "2.0.1", "cuda_ad_mono_polarized"),
    )
    monkeypatch.setattr(
        indoor_runtime, "_device_runtime_imports",
        lambda _scene=None: (FakeArray, FakeTx, FakeRx, FakeAntennaArray),
    )
    return active


def _configure_current_devices(active_runtime):
    return indoor_runtime.sync_indoor_scene_devices(
        "session-1", [_tx()], [_rx()], 28.0, SolverOptions(),
    )["deviceSync"]


def test_indoor_pathsolve_request_carries_current_placed_devices_without_a_frontend_sync_token():
    request = IndoorPathSolveRequest(
        txId="tx-1", rxId="rx-1", txs=[_tx()], rxs=[_rx()],
        carrierFrequencyGhz=28.0, maxDepth=2, options=SolverOptions(),
    )
    assert request.txId == "tx-1"
    assert request.rxId == "rx-1"
    assert request.txs[0].scenePosition == (1.0, 2.0, 1.4)
    assert request.rxs[0].scenePosition == (2.0, 1.0, 1.2)
    assert request.carrierFrequencyGhz == 28.0
    assert not hasattr(request, "deviceSyncToken")


def test_indoor_pathsolve_request_rejects_selected_pair_missing_from_current_device_snapshot():
    with pytest.raises(ValueError, match="selected TX must be included"):
        IndoorPathSolveRequest(
            txId="missing-tx", rxId="rx-1", txs=[_tx()], rxs=[_rx()],
            carrierFrequencyGhz=28.0, maxDepth=2, options=SolverOptions(),
        )


@pytest.mark.parametrize("geometry_shape", ["synthetic", "compact"])
def test_indoor_pathsolver_returns_real_path_objects_and_metrics(active_runtime, monkeypatch, geometry_shape):
    _configure_current_devices(active_runtime)
    native = _native_paths(geometry_shape=geometry_shape)
    captured = {}

    def fake_trace(scene, max_depth, options):
        captured["scene"] = scene
        captured["max_depth"] = max_depth
        captured["options"] = options
        return native

    monkeypatch.setattr(solver_module, "_trace_paths", fake_trace)
    result = indoor_runtime.solve_indoor_link(
        "session-1", "tx-1", "rx-1", 3,
        SolverOptions(pathSamplesPerSource=10_000, pathSeed=73),
    )

    assert captured["scene"] is active_runtime.scene
    assert captured["max_depth"] == 3
    assert captured["options"].pathSeed == 73
    assert result["execution"]["status"] == "completed"
    assert result["execution"]["validPathCount"] == 2
    assert result["execution"]["solver"] == "Sionna RT PathSolver"
    assert result["execution"]["sceneSessionId"] == "session-1"
    assert result["execution"]["nativeTensorShapes"]["valid"] == list(native.valid.shape)
    assert result["execution"]["normalizedTensorShapes"]["normalized"]["valid"] == [1, 1, 2]
    assert result["execution"]["normalizedTensorShapes"]["channelCoefficients"] == [1, 1, 1, 1, 2]
    assert result["metrics"].numPaths == 2
    assert result["metrics"].losStatus == "LOS"
    assert {path.type for path in result["paths"]} == {"LOS", "Reflection"}
    reflected = next(path for path in result["paths"] if path.type == "Reflection")
    line_of_sight = next(path for path in result["paths"] if path.type == "LOS")
    assert line_of_sight.points[0].model_dump() == {"x": 1.0, "y": 2.0, "z": 1.4}
    assert line_of_sight.points[-1].model_dump() == {"x": 2.0, "y": 1.0, "z": 1.2}
    assert reflected.points[1].model_dump() == {"x": 1.5, "y": 1.5, "z": 1.3}
    assert result["metrics"].totalRxPowerDbm > -200


def test_indoor_pathsolver_materializes_mitsuba_drjit_scene_frequency(active_runtime, monkeypatch):
    _configure_current_devices(active_runtime)
    # Mitsuba's Scene.frequency is mi.Float on CUDA/LLVM AD variants. Direct
    # float(scene.frequency) raises the same TypeError observed in Colab.
    active_runtime.scene.frequency = FakeDrJitScalar(28e9)
    monkeypatch.setattr(
        solver_module, "_trace_paths",
        lambda *_args: _native_paths(valid=(True,)),
    )

    result = indoor_runtime.solve_indoor_link(
        "session-1", "tx-1", "rx-1", 2, SolverOptions()
    )

    assert result["execution"]["status"] == "completed"
    assert result["execution"]["validPathCount"] == 1
    assert result["execution"]["carrierFrequencyGhz"] == 28.0


def test_indoor_pathsolver_reports_completed_no_paths_without_faking_a_path(active_runtime, monkeypatch):
    _configure_current_devices(active_runtime)
    monkeypatch.setattr(solver_module, "_trace_paths", lambda *_args: _native_paths(valid=(False, False)))
    result = indoor_runtime.solve_indoor_link("session-1", "tx-1", "rx-1", 2, SolverOptions())
    assert result["execution"]["status"] == "completed_no_paths"
    assert result["execution"]["validPathCount"] == 0
    assert result["paths"] == []
    assert result["metrics"].numPaths == 0
    assert result["metrics"].losStatus == "NLOS"


def test_indoor_pathsolver_does_not_require_a_frontend_sync_token(active_runtime, monkeypatch):
    _configure_current_devices(active_runtime)
    monkeypatch.setattr(solver_module, "_trace_paths", lambda *_args: _native_paths(valid=(True,)))

    result = indoor_runtime.solve_indoor_link("session-1", "tx-1", "rx-1", 2, SolverOptions())

    assert result["execution"]["status"] == "completed"
    assert "deviceSyncToken" not in result["execution"]


def test_indoor_pathsolver_does_not_introspect_array_row_column_attributes(active_runtime, monkeypatch):
    _configure_current_devices(active_runtime)
    # FakeArray intentionally exposes num_ant but not num_cols/num_rows.
    monkeypatch.setattr(solver_module, "_trace_paths", lambda *_args: _native_paths(valid=(True,)))

    result = indoor_runtime.solve_indoor_link("session-1", "tx-1", "rx-1", 2, SolverOptions())

    assert result["execution"]["validPathCount"] == 1


def test_indoor_pathsolver_requires_active_scene_and_synchronized_devices(active_runtime):
    active_runtime.device_sync_summary = None
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="No indoor TX/RX devices are configured"):
        indoor_runtime.solve_indoor_link("session-1", "tx-1", "rx-1", 2, SolverOptions())
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="not the active Sionna RT scene"):
        indoor_runtime.solve_indoor_link("other", "tx-1", "rx-1", 2, SolverOptions())


def test_indoor_pathsolver_rejects_unknown_device_and_invalid_depth(active_runtime, monkeypatch):
    _configure_current_devices(active_runtime)
    monkeypatch.setattr(solver_module, "_trace_paths", lambda *_args: pytest.fail("should not dispatch"))
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="not part of the current"):
        indoor_runtime.solve_indoor_link("session-1", "missing", "rx-1", 2, SolverOptions())
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="maxDepth"):
        indoor_runtime.solve_indoor_link("session-1", "tx-1", "rx-1", 21, SolverOptions())


def _rx_2():
    return Receiver(
        id="rx-2", name="Classroom RX 2", enu={"x": 0, "y": 0, "z": 0},
        antennaArraySize=(1, 1), scenePosition=(3.0, 2.0, 1.2),
        sceneOrientation=(0, 0, 0, 1), sceneSessionId="session-1",
    )


def _native_paths_multi_rx():
    """Synthetic-array Paths payload for one Tx and two distinct Rx devices."""
    valid = np.ones((2, 1, 2), dtype=bool)
    tau = np.asarray([[[10e-9, 12e-9]], [[20e-9, 24e-9]]], dtype=np.float64)
    doppler = np.zeros((2, 1, 2), dtype=np.float64)
    theta = np.full((2, 1, 2), np.pi / 2, dtype=np.float64)
    phi = np.zeros((2, 1, 2), dtype=np.float64)
    interactions = np.zeros((1, 2, 1, 2), dtype=np.uint32)
    vertices = np.zeros((1, 2, 1, 2, 3), dtype=np.float64)
    interactions[0, :, 0, 1] = 1
    vertices[0, 0, 0, 1] = [1.5, 1.5, 1.3]
    vertices[0, 1, 0, 1] = [2.5, 1.5, 1.3]
    real = np.asarray([[[[[1.0e-3, 8.0e-4]]], [[[5.0e-4, 4.0e-4]]]]], dtype=np.float64)
    # Desired layout is [rx, rx_ant, tx, tx_ant, path].
    real = real.reshape(2, 1, 1, 1, 2)
    return SimpleNamespace(
        valid=valid, tau=tau, doppler=doppler, theta_t=theta, phi_t=phi,
        theta_r=theta, phi_r=phi, interactions=interactions, vertices=vertices,
        a=(real, np.zeros_like(real)),
    )


def test_indoor_path_matrix_request_requires_unique_placed_devices():
    request = IndoorPathMatrixSolveRequest(
        txs=[_tx()], rxs=[_rx(), _rx_2()], carrierFrequencyGhz=28.0,
        maxDepth=2, options=SolverOptions(),
    )
    assert len(request.txs) == 1
    assert [device.id for device in request.rxs] == ["rx-1", "rx-2"]
    with pytest.raises(ValueError, match="must be placed"):
        IndoorPathMatrixSolveRequest(
            txs=[_tx()], rxs=[_rx(), Receiver(id="rx-unplaced", name="RX unplaced", enu={"x": 0, "y": 0, "z": 0})],
        )


def test_indoor_path_matrix_extracts_every_pair_from_one_pathsolver_dispatch(active_runtime, monkeypatch):
    indoor_runtime.sync_indoor_scene_devices(
        "session-1", [_tx()], [_rx(), _rx_2()], 28.0, SolverOptions(),
    )
    native = _native_paths_multi_rx()
    calls = []

    def fake_trace(scene, max_depth, options):
        calls.append((scene, max_depth, options))
        return native

    monkeypatch.setattr(solver_module, "_trace_paths", fake_trace)
    result = indoor_runtime.solve_indoor_link_matrix(
        "session-1", 2, SolverOptions(pathSamplesPerSource=50_000, pathSeed=19),
    )

    assert len(calls) == 1
    assert calls[0][0] is active_runtime.scene
    assert calls[0][1] == 2
    assert calls[0][2].pathSeed == 19
    assert result["execution"]["totalPairs"] == 2
    assert result["execution"]["pairsWithPaths"] == 2
    assert result["execution"]["txCount"] == 1
    assert result["execution"]["rxCount"] == 2
    assert {(pair["txId"], pair["rxId"]) for pair in result["pairs"]} == {
        ("tx-1", "rx-1"), ("tx-1", "rx-2")
    }
    first = next(pair for pair in result["pairs"] if pair["rxId"] == "rx-1")
    second = next(pair for pair in result["pairs"] if pair["rxId"] == "rx-2")
    assert first["metrics"].numPaths == 2
    assert second["metrics"].numPaths == 2
    assert first["paths"][0].points[-1].model_dump() == {"x": 2.0, "y": 1.0, "z": 1.2}
    assert second["paths"][0].points[-1].model_dump() == {"x": 3.0, "y": 2.0, "z": 1.2}
    assert first["metrics"].totalRxPowerDbm > second["metrics"].totalRxPowerDbm
