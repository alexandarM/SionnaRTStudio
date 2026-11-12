"""Indoor Channel Analysis contract tests; no Sionna/GPU runtime required."""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import numpy as np
import pytest

from backend.models import ChannelAnalysisRequest, ENUVector, SolverOptions, Transmitter
from backend import indoor_scene_runtime as indoor_runtime
from backend import solver


class _Receiver:
    def __init__(self, name: str):
        self.name = name


class _Scene:
    def __init__(self):
        self.transmitters = {"indoor_tx_1": object()}
        self.receivers = {"viewport_rx_1": _Receiver("viewport_rx_1")}
        self.tx_array = SimpleNamespace(num_ant=1)
        self.rx_array = object()
        self._rx_array = self.rx_array

    def remove(self, name: str):
        self.transmitters.pop(name, None)
        self.receivers.pop(name, None)

    def add(self, radio_device):
        self.receivers[radio_device.name] = radio_device


class _NativePaths:
    def __init__(self):
        self.valid = np.zeros((1, 1, 1), dtype=bool)

    def cir(self, normalize_delays=False, out_type="numpy"):
        a = np.ones((1, 1, 1, 1, 1, 1), dtype=np.complex128)
        tau = np.zeros((1, 1, 1), dtype=np.float64)
        return a, tau

    def cfr(self, frequencies, normalize_delays=False, out_type="numpy"):
        return np.ones((1, 1, 1, 1, 1, len(frequencies)), dtype=np.complex128)


def _one_tx():
    return Transmitter(
        id="tx-1",
        name="Indoor TX 1",
        enu=ENUVector(x=0.0, y=0.0, z=1.5),
        height=1.5,
        heightReference="scene_z",
        powerDbm=20.0,
        antennaArraySize=(1, 1),
    )


def _indoor_context():
    return {
        "sceneType": "indoor",
        "indoorSessionId": "room-session",
        "runtimeTxNames": ["indoor_tx_1"],
        "runtimeTxArray": {"numCols": 1, "numRows": 1, "pattern": "tr38901", "polarization": "V"},
        "runtimeTxSummary": [{"id": "tx-1", "runtimeName": "indoor_tx_1", "position": [0.0, 0.0, 1.5]}],
        "transmitters": [_one_tx()],
        "frequencyGhz": 28.0,
        "maxDepth": 3,
        "options": SolverOptions(),
        "buildings": [],
        "materials": [],
    }


def test_indoor_runtime_adapter_uses_the_active_scene_and_shared_solver(monkeypatch):
    scene = _Scene()
    active = SimpleNamespace(
        session_id="room-session",
        scene=scene,
        device_names={"tx": ["indoor_tx_1"], "rx": ["viewport_rx_1"]},
        summary={"radioMapTxBinding": {"txArray": _indoor_context()["runtimeTxArray"]}},
        device_sync_summary=None,
        carrier_frequency_ghz=28.0,
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(solver, "_get_cached_radio_map", lambda _map_id: {"sceneContext": _indoor_context()})
    calls = {}

    def _shared_solver(map_id, req, **kwargs):
        calls.update(map_id=map_id, req=req, **kwargs)
        return {"ok": True}

    monkeypatch.setattr(solver, "solve_radio_map_channel_analysis", _shared_solver)
    request = ChannelAnalysisRequest(cellIndices=[0], txMode="selected", txIndex=0)

    result = indoor_runtime.solve_indoor_radio_map_channel_analysis("indoor-map", request)

    assert result == {"ok": True}
    assert calls["map_id"] == "indoor-map"
    assert calls["scene_override"] is scene
    assert calls["preserve_scene_transmitters"] is True
    assert scene.transmitters.keys() == {"indoor_tx_1"}


def test_indoor_runtime_adapter_rejects_a_different_active_scene(monkeypatch):
    active = SimpleNamespace(
        session_id="another-room",
        scene=_Scene(),
        device_names={"tx": ["indoor_tx_1"], "rx": []},
        summary={},
        device_sync_summary=None,
        carrier_frequency_ghz=28.0,
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(solver, "_get_cached_radio_map", lambda _map_id: {"sceneContext": _indoor_context()})

    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="same indoor scene"):
        indoor_runtime.solve_indoor_radio_map_channel_analysis(
            "indoor-map", ChannelAnalysisRequest(cellIndices=[0])
        )


def test_indoor_runtime_adapter_rejects_changed_tx_snapshot(monkeypatch):
    context = _indoor_context()
    active = SimpleNamespace(
        session_id="room-session",
        scene=_Scene(),
        device_names={"tx": ["indoor_tx_1"], "rx": []},
        summary={"radioMapTxBinding": {"txArray": context["runtimeTxArray"]}},
        device_sync_summary={
            "transmitters": [{"id": "tx-1", "runtimeName": "indoor_tx_1", "position": [9.0, 0.0, 1.5]}]
        },
        carrier_frequency_ghz=28.0,
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(solver, "_get_cached_radio_map", lambda _map_id: {"sceneContext": context})

    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="positions, orientations, powers"):
        indoor_runtime.solve_indoor_radio_map_channel_analysis(
            "indoor-map", ChannelAnalysisRequest(cellIndices=[0])
        )


def test_indoor_runtime_adapter_rejects_changed_carrier_frequency(monkeypatch):
    context = _indoor_context()
    active = SimpleNamespace(
        session_id="room-session",
        scene=_Scene(),
        device_names={"tx": ["indoor_tx_1"], "rx": []},
        summary={"radioMapTxBinding": {"txArray": context["runtimeTxArray"]}},
        device_sync_summary=None,
        carrier_frequency_ghz=3.5,
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(solver, "_get_cached_radio_map", lambda _map_id: {"sceneContext": context})

    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="carrier frequency changed"):
        indoor_runtime.solve_indoor_radio_map_channel_analysis(
            "indoor-map", ChannelAnalysisRequest(cellIndices=[0])
        )


def test_indoor_runtime_adapter_rejects_changed_tx_array_pattern(monkeypatch):
    context = _indoor_context()
    active = SimpleNamespace(
        session_id="room-session",
        scene=_Scene(),
        device_names={"tx": ["indoor_tx_1"], "rx": []},
        summary={"radioMapTxBinding": {"txArray": context["runtimeTxArray"]}},
        device_sync_summary={
            "txArray": {"numCols": 1, "numRows": 1, "pattern": "iso", "polarization": "V"},
            "transmitters": context["runtimeTxSummary"],
        },
        carrier_frequency_ghz=28.0,
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(solver, "_get_cached_radio_map", lambda _map_id: {"sceneContext": context})

    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="antenna array changed"):
        indoor_runtime.solve_indoor_radio_map_channel_analysis(
            "indoor-map", ChannelAnalysisRequest(cellIndices=[0])
        )


def test_shared_channel_analysis_uses_live_indoor_scene_and_restores_rx_state(monkeypatch):
    fake_sionna = types.ModuleType("sionna")
    fake_rt = types.ModuleType("sionna.rt")
    fake_rt.subcarrier_frequencies = lambda count, spacing: np.arange(count, dtype=np.float64) * spacing
    fake_sionna.rt = fake_rt
    monkeypatch.setitem(sys.modules, "sionna", fake_sionna)
    monkeypatch.setitem(sys.modules, "sionna.rt", fake_rt)

    context = _indoor_context()
    cache = {
        "sceneContext": context,
        "centers": np.asarray([[1.0, 2.0, 1.2]], dtype=np.float32),
        "txMetadata": [{"id": "tx-1", "name": "Indoor TX 1"}],
        "rss": np.asarray([[1e-9]], dtype=np.float32),
        "bestRssTx": np.asarray([0], dtype=np.int32),
    }
    monkeypatch.setattr(solver, "_get_cached_radio_map", lambda _map_id: cache)

    scene = _Scene()
    original_rx = scene.rx_array
    viewport_receiver = scene.receivers["viewport_rx_1"]
    array_calls = []

    def _set_rx_array(target_scene, side, array_size, pattern, polarization):
        array_calls.append((side, tuple(array_size)))
        target_scene.rx_array = object()
        return 1

    monkeypatch.setattr(solver, "_set_planar_array", _set_rx_array)
    monkeypatch.setattr(solver, "build_scene", lambda *_args, **_kwargs: pytest.fail("indoor analysis rebuilt an outdoor scene"))

    def _batched(target_scene, tx_specs, rx_positions, rx_velocities, n_tx_ant, **kwargs):
        assert target_scene is scene
        assert kwargs["preserve_tx"] is True
        assert list(target_scene.transmitters) == ["indoor_tx_1"]
        target_scene.receivers.clear()
        target_scene.receivers["rx_b_0"] = _Receiver("rx_b_0")
        return [[([], 0.0)]], _NativePaths()

    monkeypatch.setattr(solver, "_solve_batched", _batched)
    request = ChannelAnalysisRequest(cellIndices=[0], txMode="selected", txIndex=0, rxArraySize=(1, 1), numSubcarriers=8)

    response = solver.solve_radio_map_channel_analysis(
        "indoor-map", request, scene_override=scene, preserve_scene_transmitters=True
    )

    assert response["coordinateFrame"] == "canonical_scene_local"
    assert response["execution"]["pathSolverDispatches"] == 1
    scene_position = response["locations"][0]["positionSceneLocalM"]
    assert np.allclose([scene_position["x"], scene_position["y"], scene_position["z"]], [1.0, 2.0, 1.2])
    assert "positionEnuM" not in response["locations"][0]
    assert array_calls == [("rx", (1, 1))]
    assert list(scene.transmitters) == ["indoor_tx_1"]
    assert list(scene.receivers) == ["viewport_rx_1"]
    assert scene.receivers["viewport_rx_1"] is viewport_receiver
    assert scene.rx_array is original_rx


def test_shared_channel_analysis_restores_indoor_rx_state_after_solver_error(monkeypatch):
    fake_sionna = types.ModuleType("sionna")
    fake_rt = types.ModuleType("sionna.rt")
    fake_rt.subcarrier_frequencies = lambda count, spacing: np.arange(count, dtype=np.float64) * spacing
    fake_sionna.rt = fake_rt
    monkeypatch.setitem(sys.modules, "sionna", fake_sionna)
    monkeypatch.setitem(sys.modules, "sionna.rt", fake_rt)

    context = _indoor_context()
    cache = {
        "sceneContext": context,
        "centers": np.asarray([[1.0, 2.0, 1.2]], dtype=np.float32),
        "txMetadata": [{"id": "tx-1", "name": "Indoor TX 1"}],
        "rss": np.asarray([[1e-9]], dtype=np.float32),
        "bestRssTx": np.asarray([0], dtype=np.int32),
    }
    monkeypatch.setattr(solver, "_get_cached_radio_map", lambda _map_id: cache)
    scene = _Scene()
    original_rx_array = scene.rx_array
    original_receiver = scene.receivers["viewport_rx_1"]

    def _set_rx_array(target_scene, side, _array_size, _pattern, _polarization):
        assert side == "rx"
        target_scene.rx_array = object()
        return 1

    def _failing_batch(*_args, **_kwargs):
        raise RuntimeError("synthetic PathSolver failure")

    monkeypatch.setattr(solver, "_set_planar_array", _set_rx_array)
    monkeypatch.setattr(solver, "_solve_batched", _failing_batch)

    with pytest.raises(RuntimeError, match="synthetic PathSolver failure"):
        solver.solve_radio_map_channel_analysis(
            "indoor-map",
            ChannelAnalysisRequest(cellIndices=[0], txMode="selected", txIndex=0, rxArraySize=(1, 1), numSubcarriers=8),
            scene_override=scene,
            preserve_scene_transmitters=True,
        )

    assert list(scene.transmitters) == ["indoor_tx_1"]
    assert list(scene.receivers) == ["viewport_rx_1"]
    assert scene.receivers["viewport_rx_1"] is original_receiver
    assert scene.rx_array is original_rx_array
