from __future__ import annotations

from types import SimpleNamespace

import pytest

import backend.indoor_scene_runtime as indoor_runtime
import backend.solver as solver_module
from backend.models import (
    ENUVector,
    IndoorMobilityRequest,
    MobilityRequest,
    Receiver,
    SolverOptions,
    Transmitter,
)


class FakeScene:
    def __init__(self):
        self.transmitters = {}
        self.receivers = {}
        self.tx_array = SimpleNamespace(num_ant=1)
        self.rx_array = object()

    def add(self, item):
        self.receivers[item.name] = item

    def remove(self, name):
        self.transmitters.pop(name, None)
        self.receivers.pop(name, None)


def _tx(device_id="tx-1", *, session="room-1", position=(1.0, 2.0, 1.3)):
    return Transmitter(
        id=device_id,
        name=f"Indoor {device_id}",
        enu={"x": 0.0, "y": 0.0, "z": 0.0},
        powerDbm=23.0,
        antennaArraySize=(1, 1),
        beamSteeringFrame="device_local",
        scenePosition=position,
        sceneOrientation=(0.0, 0.0, 0.0, 1.0),
        sceneSessionId=session,
    )


def _rx(*, session="room-1", position=(2.0, 1.0, 1.2)):
    return Receiver(
        id="rx-1",
        name="Moving RX",
        enu={"x": 0.0, "y": 0.0, "z": 0.0},
        height=1.2,
        antennaArraySize=(1, 1),
        scenePosition=position,
        sceneOrientation=(0.0, 0.0, 0.0, 1.0),
        sceneSessionId=session,
    )


def _request(*, txs=None, rx=None, waypoints=None, execution_mode="batched", speed_kmh=3.0):
    return IndoorMobilityRequest(
        txs=txs if txs is not None else [_tx()],
        rx=rx if rx is not None else _rx(),
        waypoints=waypoints if waypoints is not None else [
            ENUVector(x=-1.0, y=-1.0, z=1.2),
            ENUVector(x=1.0, y=1.0, z=1.2),
        ],
        freqGhz=28.0,
        speedKmh=speed_kmh,
        maxDepth=2,
        options=SolverOptions(),
        combineMode="best_server",
        executionMode=execution_mode,
    )


@pytest.fixture
def active_indoor_scene(monkeypatch):
    scene = FakeScene()
    active = indoor_runtime.ActiveIndoorScene(
        session_id="room-1",
        scene=scene,
        carrier_frequency_ghz=28.0,
        material_mappings={"wall": "itu-concrete"},
        summary={
            "activation": "active",
            "canonicalBounds": {
                "minimum": [-4.0, -4.0, 0.0],
                "maximum": [4.0, 4.0, 1.46],
            },
            "coordinateFrame": {"upAxis": "+Z", "forwardAxis": "+X", "units": "m", "handedness": "right"},
        },
        activated_at="now",
        canonical_xml_path="/tmp/classroom.xml",
        device_names={"tx": [], "rx": []},
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    return active


def test_indoor_mobility_request_requires_placed_tx_but_not_a_separate_viewport_rx():
    with pytest.raises(ValueError, match="scenePosition"):
        _request(txs=[_tx().model_copy(update={"scenePosition": None})])
    # The trajectory waypoints define the moving RX position. The RX model is
    # only the antenna/configuration template and need not be placed in 3D.
    unplaced_rx = _rx(session=None).model_copy(update={"scenePosition": None, "sceneSessionId": None})
    request = _request(rx=unplaced_rx)
    assert request.rx.scenePosition is None
    assert request.rx.sceneSessionId is None



def test_indoor_and_outdoor_mobility_accept_slow_speed_floor():
    indoor = _request(speed_kmh=0.1)
    assert indoor.speedKmh == pytest.approx(0.1)
    with pytest.raises(ValueError):
        _request(speed_kmh=0.09)

    outdoor = MobilityRequest(
        txs=[_tx()],
        rx=_rx(),
        buildings=[],
        waypoints=[ENUVector(x=0.0, y=0.0, z=1.0), ENUVector(x=1.0, y=0.0, z=1.0)],
        speedKmh=0.1,
    )
    assert outdoor.speedKmh == pytest.approx(0.1)
    with pytest.raises(ValueError):
        MobilityRequest(
            txs=[_tx()], rx=_rx(), buildings=[],
            waypoints=[ENUVector(x=0.0, y=0.0, z=1.0), ENUVector(x=1.0, y=0.0, z=1.0)],
            speedKmh=0.09,
        )

def test_indoor_mobility_request_accepts_multiple_tx_and_local_waypoints():
    request = _request(
        txs=[_tx("tx-1"), _tx("tx-2", position=(-1.0, 1.0, 1.3))],
        waypoints=[ENUVector(x=-1, y=0, z=1.1), ENUVector(x=1, y=0, z=1.1)],
    )
    assert [tx.id for tx in request.transmitters()] == ["tx-1", "tx-2"]
    assert request.waypoints[0].x == pytest.approx(-1.0)


def test_indoor_mobility_adapter_reuses_active_scene_and_shared_solver(active_indoor_scene, monkeypatch):
    captured = {}

    def fake_sync(session_id, txs, rxs, carrier_frequency_ghz, solver_options):
        captured["sync"] = {
            "session_id": session_id,
            "txs": list(txs),
            "rxs": list(rxs),
            "carrier_frequency_ghz": carrier_frequency_ghz,
            "options": solver_options,
        }
        active_indoor_scene.scene.transmitters = {"indoor_tx_0": object()}
        active_indoor_scene.scene.receivers = {"indoor_rx_0": object()}
        return {
            "active": True,
            "sessionId": session_id,
            "summary": {},
            "deviceSync": {"transmitters": [{"runtimeName": "indoor_tx_0"}]},
        }

    def fake_solver(req, **kwargs):
        captured["request"] = req
        captured["solver_kwargs"] = kwargs
        return (["steps"], {"strategy": "single_batched_dispatch"}, None)

    monkeypatch.setattr(indoor_runtime, "sync_indoor_scene_devices", fake_sync)
    monkeypatch.setattr(solver_module, "solve_mobility", fake_solver)

    unplaced_rx = _rx(session=None).model_copy(update={"scenePosition": None, "sceneSessionId": None})
    result = indoor_runtime.solve_indoor_mobility("room-1", _request(rx=unplaced_rx))

    assert result[0] == ["steps"]
    assert captured["sync"]["session_id"] == "room-1"
    assert len(captured["sync"]["txs"]) == 1
    synthesized_rx = captured["sync"]["rxs"][0]
    assert synthesized_rx.scenePosition == (-1.0, -1.0, 1.2)
    assert synthesized_rx.sceneSessionId == "room-1"
    assert synthesized_rx.sceneOrientation == (0.0, 0.0, 0.0, 1.0)
    normalized = captured["request"]
    assert normalized.txs[0].enu == ENUVector(x=1.0, y=2.0, z=1.3)
    assert normalized.rx.enu == ENUVector(x=-1.0, y=-1.0, z=1.2)
    assert [(p.x, p.y, p.z) for p in normalized.waypoints] == [(-1.0, -1.0, 1.2), (1.0, 1.0, 1.2)]
    assert captured["solver_kwargs"]["prepared_tx_names"] == ["indoor_tx_0"]
    assert captured["solver_kwargs"] == {
        "scene_override": active_indoor_scene.scene,
        "prepared_tx_names": ["indoor_tx_0"],
        "preserve_scene_transmitters": True,
        "receiver_orientation": indoor_runtime.canonical_device_orientation_to_sionna_euler(
            (0.0, 0.0, 0.0, 1.0)
        ),
    }


def test_indoor_mobility_uses_upright_rx_template_when_previous_scene_pose_is_stale(active_indoor_scene, monkeypatch):
    captured = {}

    def fake_sync(session_id, txs, rxs, carrier_frequency_ghz, solver_options):
        captured["rx"] = rxs[0]
        active_indoor_scene.scene.transmitters = {"indoor_tx_0": object()}
        active_indoor_scene.scene.receivers = {"indoor_rx_0": object()}
        return {
            "active": True,
            "sessionId": session_id,
            "summary": {},
            "deviceSync": {"transmitters": [{"runtimeName": "indoor_tx_0"}]},
        }

    monkeypatch.setattr(indoor_runtime, "sync_indoor_scene_devices", fake_sync)
    monkeypatch.setattr(
        solver_module,
        "solve_mobility",
        lambda req, **kwargs: ([], {"strategy": "single_batched_dispatch"}, None),
    )
    stale_rx = _rx(session="old-room", position=(20.0, 20.0, 20.0))
    request = _request(rx=stale_rx)
    indoor_runtime.solve_indoor_mobility("room-1", request)

    assert captured["rx"].scenePosition == (-1.0, -1.0, 1.2)
    assert captured["rx"].sceneSessionId == "room-1"
    assert captured["rx"].sceneOrientation == (0.0, 0.0, 0.0, 1.0)


def test_indoor_mobility_rejects_waypoints_outside_room_before_sync(active_indoor_scene, monkeypatch):
    monkeypatch.setattr(
        indoor_runtime,
        "sync_indoor_scene_devices",
        lambda **_kwargs: pytest.fail("scene device sync must not run for an out-of-bounds path"),
    )
    request = _request(waypoints=[
        ENUVector(x=-1, y=0, z=1.2),
        ENUVector(x=8.0, y=0, z=1.2),
    ])
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="outside the active scene bounds"):
        indoor_runtime.solve_indoor_mobility("room-1", request)


@pytest.mark.parametrize("execution_mode", ["batched", "serial_reference"])
def test_shared_mobility_solver_preserves_indoor_tx_and_viewport_rx(
    active_indoor_scene, monkeypatch, execution_mode,
):
    scene = active_indoor_scene.scene
    tx_runtime = SimpleNamespace(name="indoor_tx_0")
    viewport_rx = SimpleNamespace(name="indoor_rx_0")
    scene.transmitters = {"indoor_tx_0": tx_runtime}
    scene.receivers = {"indoor_rx_0": viewport_rx}
    calls = {}

    monkeypatch.setattr(
        solver_module,
        "build_scene",
        lambda *_args, **_kwargs: pytest.fail("indoor mobility must reuse the active scene"),
    )
    monkeypatch.setattr(
        solver_module,
        "_set_tx_array",
        lambda *_args, **_kwargs: pytest.fail("indoor TX array must not be recreated by outdoor solver setup"),
    )
    monkeypatch.setattr(
        solver_module,
        "_set_rx_array",
        lambda *_args, **_kwargs: pytest.fail("indoor RX array must not be recreated by outdoor solver setup"),
    )

    def fake_batched(_scene, tx_specs, rx_positions, _velocities, _num_ant, **kwargs):
        calls["tx_specs"] = tx_specs
        calls["positions"] = rx_positions
        calls["preserve_tx"] = kwargs.get("preserve_tx")
        calls["rx_orientation"] = kwargs.get("rx_orientation")
        _scene.receivers.clear()
        _scene.add(SimpleNamespace(name="mobility_rx_0"))
        return [[([], 0.0) for _ in tx_specs] for _ in rx_positions]

    def fake_at(_scene, tx_pos, rx_pos, *_args, **kwargs):
        calls.setdefault("serial_preserve_tx", []).append(kwargs.get("preserve_tx"))
        calls.setdefault("serial_positions", []).append((tx_pos, rx_pos))
        calls.setdefault("serial_orientations", []).append(kwargs.get("rx_orientation"))
        return [], 0.0

    monkeypatch.setattr(solver_module, "_solve_batched", fake_batched)
    monkeypatch.setattr(solver_module, "_solve_at", fake_at)
    monkeypatch.setattr(solver_module, "_handover_analysis", lambda *_args: None)

    request = _request(execution_mode=execution_mode)
    request = request.model_copy(update={
        "txs": [request.txs[0].model_copy(update={"enu": ENUVector(x=1.0, y=2.0, z=1.3)})],
        "rx": request.rx.model_copy(update={"enu": ENUVector(x=2.0, y=1.0, z=1.2)}),
    })
    # The common solver only uses these outdoor-only fields when no scene
    # override is supplied. Keeping them absent verifies the indoor branch.
    steps, execution, handover = solver_module.solve_mobility(
        request,
        scene_override=scene,
        prepared_tx_names=["indoor_tx_0"],
        preserve_scene_transmitters=True,
        receiver_orientation=indoor_runtime.canonical_device_orientation_to_sionna_euler(
            request.rx.sceneOrientation
        ),
    )

    assert len(steps) == 2
    assert execution["pairCount"] == 2
    assert handover is None
    assert scene.transmitters == {"indoor_tx_0": tx_runtime}
    assert scene.receivers == {"indoor_rx_0": viewport_rx}
    if execution_mode == "batched":
        assert calls["tx_specs"][0].pos == [1.0, 2.0, 1.3]
        assert calls["positions"] == [[-1.0, -1.0, 1.2], [1.0, 1.0, 1.2]]
        assert calls["preserve_tx"] is True
        assert calls["rx_orientation"] == indoor_runtime.canonical_device_orientation_to_sionna_euler(
            request.rx.sceneOrientation
        )
    else:
        assert calls["serial_preserve_tx"] == [True, True]
        expected_orientation = indoor_runtime.canonical_device_orientation_to_sionna_euler(
            request.rx.sceneOrientation
        )
        assert calls["serial_orientations"] == [expected_orientation, expected_orientation]
        assert calls["serial_positions"] == [
            ([1.0, 2.0, 1.3], [-1.0, -1.0, 1.2]),
            ([1.0, 2.0, 1.3], [1.0, 1.0, 1.2]),
        ]


def test_indoor_mobility_runtime_receivers_keep_scene_rx_orientation(monkeypatch):
    import sys
    from types import ModuleType

    constructed = []

    class FakeReceiver:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            constructed.append(kwargs)

    fake_sionna = ModuleType("sionna")
    fake_rt = ModuleType("sionna.rt")
    fake_rt.Receiver = FakeReceiver
    fake_sionna.rt = fake_rt
    monkeypatch.setitem(sys.modules, "sionna", fake_sionna)
    monkeypatch.setitem(sys.modules, "sionna.rt", fake_rt)
    monkeypatch.setattr(
        solver_module,
        "_trace_paths",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("stop after receiver registration")),
    )

    class Scene:
        def __init__(self):
            self.receivers = {"viewport_rx": SimpleNamespace(name="viewport_rx")}
            self.transmitters = {"active_tx": SimpleNamespace(name="active_tx")}
            self.added = []

        def remove(self, name):
            self.receivers.pop(name, None)

        def add(self, receiver):
            self.added.append(receiver)
            self.receivers[receiver.name] = receiver

    scene = Scene()
    orientation = (0.2, -0.3, 0.4)
    with pytest.raises(RuntimeError, match="stop after receiver registration"):
        solver_module._solve_batched(
            scene, [], [[1.0, 2.0, 1.2]], [[0.0, 0.0, 0.0]], 1,
            preserve_tx=True, rx_orientation=orientation,
        )

    assert constructed == [{
        "name": "rx_b_0", "position": [1.0, 2.0, 1.2], "orientation": orientation,
    }]
    assert scene.transmitters.keys() == {"active_tx"}


def test_indoor_serial_fallback_receivers_keep_scene_rx_orientation(monkeypatch):
    import sys
    from types import ModuleType

    constructed = []

    class FakeReceiver:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            constructed.append(kwargs)

    fake_sionna = ModuleType("sionna")
    fake_rt = ModuleType("sionna.rt")
    fake_rt.Receiver = FakeReceiver
    fake_sionna.rt = fake_rt
    monkeypatch.setitem(sys.modules, "sionna", fake_sionna)
    monkeypatch.setitem(sys.modules, "sionna.rt", fake_rt)
    monkeypatch.setattr(
        solver_module,
        "_trace_paths",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("stop after receiver registration")),
    )

    class Scene:
        def __init__(self):
            self.receivers = {"viewport_rx": SimpleNamespace(name="viewport_rx")}
            self.transmitters = {"active_tx": SimpleNamespace(name="active_tx")}

        def remove(self, name):
            self.receivers.pop(name, None)

        def add(self, receiver):
            self.receivers[receiver.name] = receiver

    scene = Scene()
    orientation = (-0.1, 0.25, 0.6)
    with pytest.raises(RuntimeError, match="stop after receiver registration"):
        solver_module._solve_at(
            scene, [1.0, 2.0, 1.3], [-1.0, -1.0, 1.2], 23.0, 1,
            preserve_tx=True, rx_orientation=orientation,
        )

    assert constructed == [{
        "name": "rx_d", "position": [-1.0, -1.0, 1.2], "orientation": orientation,
    }]
    assert scene.transmitters.keys() == {"active_tx"}
