from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

import backend.indoor_scene_runtime as indoor_runtime
import backend.solver as solver_module
from backend.models import IndoorRadioMapRequest, SolverOptions, Transmitter


class FakeAntennaArray:
    pass


class FakeArray(FakeAntennaArray):
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeTx:
    def __init__(self, *, name, position, orientation, power_dbm):
        self.name = name
        self.position = tuple(position)
        self.orientation = tuple(orientation)
        self.power_dbm = power_dbm


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
            raise TypeError("wrong TX array class")
        self._tx_array = value

    @property
    def rx_array(self):
        return self._rx_array

    @rx_array.setter
    def rx_array(self, value):
        if not isinstance(value, FakeAntennaArray):
            raise TypeError("wrong RX array class")
        self._rx_array = value

    def add(self, item):
        if isinstance(item, (list, tuple)):
            raise AttributeError("'list' object has no attribute 'name'")
        self.transmitters[item.name] = item

    def remove(self, name):
        self.transmitters.pop(name, None)
        self.receivers.pop(name, None)


def _tx(device_id="tx-1", *, session="room-1", position=(1.0, 2.0, 1.3), array=(1, 1)):
    return Transmitter(
        id=device_id,
        name=f"Indoor {device_id}",
        enu={"x": 0.0, "y": 0.0, "z": 0.0},
        powerDbm=23.0,
        antennaArraySize=array,
        beamSteeringFrame="device_local",
        indoorBeamSteering={"azimuthDeg": 0.0, "elevationDeg": 0.0},
        scenePosition=position,
        sceneOrientation=(0.0, 0.0, 0.0, 1.0),
        sceneSessionId=session,
    )


@pytest.fixture
def active_indoor_scene(monkeypatch):
    scene = FakeScene()
    active = indoor_runtime.ActiveIndoorScene(
        session_id="room-1",
        scene=scene,
        carrier_frequency_ghz=28.0,
        material_mappings={"wall": "itu_concrete"},
        summary={
            "activation": "active",
            "canonicalBounds": {
                "minimum": [-4.0, -4.0, 0.0],
                "maximum": [4.0, 4.0, 1.46],
            },
            "coordinateFrame": {"upAxis": "+Z", "forwardAxis": "+X", "units": "m", "handedness": "right"},
            "deviceSync": {"status": "synchronized"},
        },
        activated_at="now",
        canonical_xml_path="/tmp/classroom.xml",
        device_names={"tx": [], "rx": []},
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(
        indoor_runtime,
        "_runtime_imports",
        lambda: (object(), None, {"itu_concrete": {(1.0, 100.0): (1, 2, 3, 4)}}, object, "2.0.1", "cuda_ad_mono_polarized"),
    )
    monkeypatch.setattr(
        indoor_runtime,
        "_device_runtime_imports",
        lambda _scene=None: (FakeArray, FakeTx, None, FakeAntennaArray),
    )
    return active


def _request(*, txs=None, grid_size=0.5, grid_height=1.2):
    return IndoorRadioMapRequest(
        txs=txs if txs is not None else [_tx()],
        freqGhz=28.0,
        gridSize=grid_size,
        gridHeight=grid_height,
        maxDepth=2,
        options=SolverOptions(),
        metric="power",
        bandwidthHz=100e6,
        noiseFigureDb=7.0,
        samplesPerTx=10_000,
        seed=11,
    )


def test_indoor_radiomap_request_requires_scene_local_tx_pose_and_session():
    with pytest.raises(ValueError, match="scenePosition"):
        IndoorRadioMapRequest(txs=[_tx().model_copy(update={"scenePosition": None})])

    with pytest.raises(ValueError, match="scene session"):
        IndoorRadioMapRequest(txs=[_tx().model_copy(update={"sceneSessionId": None})])


def test_indoor_radiomap_request_accepts_multiple_scene_local_tx():
    request = _request(txs=[_tx("tx-1"), _tx("tx-2", position=(-1.0, 1.0, 1.3))])
    assert [tx.id for tx in request.txs] == ["tx-1", "tx-2"]
    assert request.gridSize == pytest.approx(0.5)
    assert request.gridHeight == pytest.approx(1.2)


def test_indoor_radiomap_runs_on_active_scene_without_needing_viewport_rx(
    active_indoor_scene, monkeypatch,
):
    captured = {}

    def fake_solve(req, **kwargs):
        captured["request"] = req
        captured.update(kwargs)
        return {"status": "mocked-radio-map", "cells": []}

    monkeypatch.setattr(solver_module, "solve_radiomap", fake_solve)
    request = _request()
    result = indoor_runtime.solve_indoor_radiomap("room-1", request)

    assert result["status"] == "mocked-radio-map"
    assert captured["scene_override"] is active_indoor_scene.scene
    assert captured["scene_bounds"] == {
        "minimum": [-4.0, -4.0, 0.0],
        "maximum": [4.0, 4.0, 1.46],
    }
    assert captured["map_height_z"] == pytest.approx(1.2)
    assert captured["device_positions"] == {"tx-1": [1.0, 2.0, 1.3]}
    assert captured["devices_prepared"] is True
    assert len(active_indoor_scene.scene.transmitters) == 1
    assert active_indoor_scene.scene.receivers == {}
    assert active_indoor_scene.summary.get("deviceSync") is None
    assert active_indoor_scene.summary["radioMapTxBinding"]["transmitterCount"] == 1
    assert captured["request"].buildings == []
    assert captured["request"].txs[0].enu.x == pytest.approx(1.0)
    assert captured["request"].txs[0].enu.y == pytest.approx(2.0)
    assert captured["scene_context_extra"]["sceneType"] == "indoor"


def test_indoor_radiomap_rejects_tx_from_another_scene(active_indoor_scene, monkeypatch):
    monkeypatch.setattr(solver_module, "solve_radiomap", lambda *args, **kwargs: pytest.fail("solver must not run"))
    request = _request(txs=[_tx(session="another-room")])
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="belong to the active indoor scene"):
        indoor_runtime.solve_indoor_radiomap("room-1", request)


def test_indoor_radiomap_rejects_grid_plane_outside_scene_height(active_indoor_scene, monkeypatch):
    monkeypatch.setattr(solver_module, "solve_radiomap", lambda *args, **kwargs: pytest.fail("solver must not run"))
    request = _request(grid_height=1.46)
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="outside the indoor scene's vertical span"):
        indoor_runtime.solve_indoor_radiomap("room-1", request)


def test_shared_radio_map_solver_uses_scene_override_without_outdoor_scene_build(
    monkeypatch,
):
    import sys
    from types import ModuleType

    scene = FakeScene()
    scene.tx_array = FakeArray(num_rows=1, num_cols=1)
    runtime_tx = FakeTx(
        name="app_tx_1", position=(1.0, 2.0, 1.3),
        orientation=(0.0, 0.0, 0.0), power_dbm=23.0,
    )
    scene.transmitters[runtime_tx.name] = runtime_tx
    request = _request()
    request = request.model_copy(update={
        "txs": [request.txs[0].model_copy(update={
            "enu": {"x": 1.0, "y": 2.0, "z": 1.3},
            "height": 1.3,
            "heightReference": "scene_z",
        })],
        "buildings": [],
    })
    captured = {}

    class FakeRadioMapSolver:
        def __call__(self, active_scene, **kwargs):
            captured["scene"] = active_scene
            captured["kwargs"] = kwargs
            return SimpleNamespace(
                cell_centers=np.asarray([
                    [-2.0, -2.0, 1.2],
                    [2.0, 2.0, 1.2],
                ], dtype=np.float32),
                path_gain=np.asarray([[1e-11, 2e-11]], dtype=np.float32),
                rss=np.asarray([[1e-9, 2e-9]], dtype=np.float32),
                sinr=np.asarray([[1.0, 2.0]], dtype=np.float32),
            )

    fake_sionna = ModuleType("sionna")
    fake_rt = ModuleType("sionna.rt")
    fake_rt.RadioMapSolver = FakeRadioMapSolver
    fake_sionna.rt = fake_rt
    monkeypatch.setitem(sys.modules, "sionna", fake_sionna)
    monkeypatch.setitem(sys.modules, "sionna.rt", fake_rt)
    monkeypatch.setattr(
        solver_module, "build_scene",
        lambda *args, **kwargs: pytest.fail("indoor call must not build an outdoor OSM scene"),
    )

    result = solver_module.solve_radiomap(
        request,
        scene_override=scene,
        scene_bounds={"minimum": [-4.0, -4.0, 0.0], "maximum": [4.0, 4.0, 1.46]},
        map_height_z=1.2,
        device_positions={"tx-1": [1.0, 2.0, 1.3]},
        devices_prepared=True,
        prepared_tx_names=["app_tx_1"],
        scene_context_extra={"sceneType": "indoor", "indoorSessionId": "room-1"},
    )

    assert captured["scene"] is scene
    assert captured["kwargs"]["center"] == pytest.approx([0.0, 0.0, 1.2])
    assert captured["kwargs"]["size"] == pytest.approx([8.0, 8.0])
    assert captured["kwargs"]["cell_size"] == pytest.approx([0.5, 0.5])
    assert len(result.cells) == 2
    assert result.heightOffset == pytest.approx(1.2)
    assert result.simulationConfig["sceneType"] == "indoor"
    assert result.simulationConfig["transmitters"][0]["positionSceneLocalM"] == pytest.approx([1.0, 2.0, 1.3])
    assert "positionEnuM" not in result.simulationConfig["transmitters"][0]
    cached = solver_module.get_radio_map_tx_data(result.mapId, 0)
    assert cached["metadata"]["positionM"] == pytest.approx([1.0, 2.0, 1.3])
    assert cached["metadata"]["coordinateFrame"] == "canonical_scene_local"
    assert result.cells[0].z == pytest.approx(1.2)
