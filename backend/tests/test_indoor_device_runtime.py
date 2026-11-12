from __future__ import annotations

import math
import sys
from types import SimpleNamespace

import numpy as np
import pytest

import backend.indoor_scene_runtime as indoor_runtime
from backend.models import (
    IndoorSceneDeviceSyncRequest,
    IndoorBeamSteering,
    Receiver,
    SolverOptions,
    Transmitter,
)


def _rotation_from_sionna_euler(angles):
    alpha, beta, gamma = angles
    ca, sa = math.cos(alpha), math.sin(alpha)
    cb, sb = math.cos(beta), math.sin(beta)
    cc, sc = math.cos(gamma), math.sin(gamma)
    rz = np.asarray([[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]], dtype=float)
    ry = np.asarray([[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]], dtype=float)
    rx = np.asarray([[1, 0, 0], [0, cc, -sc], [0, sc, cc]], dtype=float)
    return rz @ ry @ rx


def _tx(device_id="tx-1", *, array=(4, 2), steering=(0.0, 0.0), session="session-1", position=(1.0, 2.0, 1.4), quaternion=(0, 0, 0, 1)):
    return Transmitter(
        id=device_id,
        name=f"TX {device_id}",
        enu={"x": 0, "y": 0, "z": 0},
        powerDbm=27.0,
        antennaArraySize=array,
        beamSteeringFrame="device_local",
        indoorBeamSteering={"azimuthDeg": steering[0], "elevationDeg": steering[1]},
        scenePosition=position,
        sceneOrientation=quaternion,
        sceneSessionId=session,
    )


def _rx(device_id="rx-1", *, array=(1, 1), session="session-1", position=(2.0, 1.0, 1.2), quaternion=(0, 0, 0, 1)):
    return Receiver(
        id=device_id,
        name=f"RX {device_id}",
        enu={"x": 0, "y": 0, "z": 0},
        antennaArraySize=array,
        scenePosition=position,
        sceneOrientation=quaternion,
        sceneSessionId=session,
    )


class FakeAntennaArray:
    """Strict stand-in for Sionna's AntennaArray base class."""


class FakeArray(FakeAntennaArray):
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeTx:
    def __init__(self, *, name, position, orientation, power_dbm):
        self.name = name
        self.position = tuple(position)
        self.orientation = tuple(orientation)
        self.power_dbm = power_dbm


class FakeRx:
    def __init__(self, *, name, position, orientation):
        self.name = name
        self.position = tuple(position)
        self.orientation = tuple(orientation)


class FakeDrJitScalar:
    """Mimic a Mitsuba/Dr.Jit scalar that must be converted via .numpy()."""

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

    def add(self, item):
        # Sionna RT Scene.add() registers one object per call.
        if isinstance(item, (list, tuple)):
            raise AttributeError("'list' object has no attribute 'name'")
        if isinstance(item, FakeTx):
            self.transmitters[item.name] = item
        elif isinstance(item, FakeRx):
            self.receivers[item.name] = item
        else:
            raise TypeError(type(item))

    def remove(self, name):
        self.transmitters.pop(name, None)
        self.receivers.pop(name, None)


@pytest.fixture
def active_runtime(monkeypatch):
    scene = FakeScene()
    active = indoor_runtime.ActiveIndoorScene(
        session_id="session-1",
        scene=scene,
        carrier_frequency_ghz=28.0,
        material_mappings={"wall": "concrete"},
        summary={"activation": "active", "carrierFrequencyGhz": 28.0},
        activated_at="now",
        canonical_xml_path="/tmp/scene.xml",
        device_names={"tx": [], "rx": []},
    )
    monkeypatch.setattr(indoor_runtime, "_ACTIVE_SCENE", active)
    monkeypatch.setattr(
        indoor_runtime,
        "_runtime_imports",
        lambda: (object(), None, {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}}, object, "2.0.1", "cuda_ad_mono_polarized"),
    )
    monkeypatch.setattr(
        indoor_runtime, "_device_runtime_imports",
        lambda _scene=None: (FakeArray, FakeTx, FakeRx, FakeAntennaArray),
    )
    return active



def test_device_runtime_imports_use_the_active_scene_module_class_identity(monkeypatch):
    module = sys.modules[FakeScene.__module__]
    monkeypatch.setattr(module, "AntennaArray", FakeAntennaArray, raising=False)
    monkeypatch.setattr(module, "PlanarArray", FakeArray, raising=False)
    monkeypatch.setattr(module, "Transmitter", FakeTx, raising=False)
    monkeypatch.setattr(module, "Receiver", FakeRx, raising=False)

    resolved = indoor_runtime._device_runtime_imports(FakeScene())

    assert resolved == (FakeArray, FakeTx, FakeRx, FakeAntennaArray)
    assert issubclass(resolved[0], resolved[3])


def test_device_runtime_imports_reject_a_planar_array_from_a_different_class_hierarchy(monkeypatch):
    from types import SimpleNamespace

    ForeignAntennaArray = type(
        "ForeignAntennaArray", (), {"__module__": "fake_sionna_antenna_module"}
    )
    scene_module = SimpleNamespace(
        AntennaArray=ForeignAntennaArray,
        Transmitter=FakeTx,
        Receiver=FakeRx,
    )
    antenna_module = SimpleNamespace(PlanarArray=FakeArray)
    original_import_module = indoor_runtime.importlib.import_module

    def fake_import_module(name):
        if name == FakeScene.__module__:
            return scene_module
        if name == "fake_sionna_antenna_module":
            return antenna_module
        return original_import_module(name)

    monkeypatch.setattr(indoor_runtime.importlib, "import_module", fake_import_module)
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="does not inherit from it"):
        indoor_runtime._device_runtime_imports(FakeScene())


def test_identity_canonical_pose_maps_sionna_boresight_plus_x_to_canonical_plus_z():
    euler = indoor_runtime.canonical_device_orientation_to_sionna_euler((0, 0, 0, 1))
    rotation = _rotation_from_sionna_euler(euler)
    # Sionna's local +X boresight is canonical +Z for an upright device.
    assert rotation @ np.asarray([1.0, 0.0, 0.0]) == pytest.approx([0.0, 0.0, 1.0], abs=1e-8)
    # Sionna's planar Y/Z array axes correspond to canonical X/Y respectively.
    assert rotation @ np.asarray([0.0, 1.0, 0.0]) == pytest.approx([1.0, 0.0, 0.0], abs=1e-8)
    assert rotation @ np.asarray([0.0, 0.0, 1.0]) == pytest.approx([0.0, 1.0, 0.0], abs=1e-8)
    assert np.linalg.det(rotation) == pytest.approx(1.0)


def test_local_steering_rotates_sionna_boresight_in_canonical_frame():
    euler = indoor_runtime.canonical_device_orientation_to_sionna_euler(
        (0, 0, 0, 1), steering_azimuth_deg=90, steering_elevation_deg=0
    )
    rotation = _rotation_from_sionna_euler(euler)
    assert rotation @ np.asarray([1.0, 0.0, 0.0]) == pytest.approx([1.0, 0.0, 0.0], abs=1e-8)


def test_local_elevation_steering_rotates_boresight_toward_canonical_y():
    euler = indoor_runtime.canonical_device_orientation_to_sionna_euler(
        (0, 0, 0, 1), steering_azimuth_deg=0, steering_elevation_deg=30
    )
    rotation = _rotation_from_sionna_euler(euler)
    expected = [0.0, math.sin(math.radians(30)), math.cos(math.radians(30))]
    assert rotation @ np.asarray([1.0, 0.0, 0.0]) == pytest.approx(expected, abs=1e-8)


def test_mount_quaternion_is_composed_before_local_steering():
    yaw_90 = (0.0, 0.0, math.sin(math.pi / 4), math.cos(math.pi / 4))
    euler = indoor_runtime.canonical_device_orientation_to_sionna_euler(
        yaw_90, steering_azimuth_deg=90, steering_elevation_deg=0
    )
    rotation = _rotation_from_sionna_euler(euler)
    # Local +Z steers to local +X, then the mounted +90° yaw rotates it to +Y.
    assert rotation @ np.asarray([1.0, 0.0, 0.0]) == pytest.approx([0.0, 1.0, 0.0], abs=1e-8)


def test_zero_length_quaternion_is_rejected():
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="zero-length quaternion"):
        indoor_runtime.canonical_device_orientation_to_sionna_euler((0, 0, 0, 0))


def test_steering_range_is_validated():
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="within ±180°"):
        indoor_runtime.canonical_device_orientation_to_sionna_euler((0, 0, 0, 1), steering_azimuth_deg=181)


def test_sync_registers_tx_rx_arrays_positions_and_frequency(active_runtime):
    result = indoor_runtime.sync_indoor_scene_devices(
        "session-1", [_tx()], [_rx()], 28.0, SolverOptions(txPattern="tr38901", txPolarization="V", rxPattern="iso", rxPolarization="V")
    )
    scene = active_runtime.scene
    assert result["deviceSync"]["status"] == "synchronized"
    assert len(scene.transmitters) == 1
    assert len(scene.receivers) == 1
    assert scene.frequency == pytest.approx(28e9)
    assert scene.tx_array.kwargs == {
        "num_rows": 2, "num_cols": 4, "vertical_spacing": 0.5,
        "horizontal_spacing": 0.5, "pattern": "tr38901", "polarization": "V",
    }
    assert scene.rx_array.kwargs["num_rows"] == 1
    tx = next(iter(scene.transmitters.values()))
    rx = next(iter(scene.receivers.values()))
    assert tx.position == pytest.approx((1, 2, 1.4))
    assert rx.position == pytest.approx((2, 1, 1.2))
    assert tx.power_dbm == pytest.approx(27.0)
    assert result["deviceSync"]["arraySpacingMeters"] == pytest.approx(299_792_458 / 28e9 * 0.5)
    assert active_runtime.device_names == {"tx": [tx.name], "rx": [rx.name]}


def test_sync_reads_previous_mitsuba_drjit_frequency_via_numpy_bridge(active_runtime):
    active_runtime.scene.frequency = FakeDrJitScalar(28e9)

    result = indoor_runtime.sync_indoor_scene_devices(
        "session-1", [_tx()], [_rx()], 28.0, SolverOptions()
    )

    assert result["deviceSync"]["status"] == "synchronized"
    assert active_runtime.scene.frequency == pytest.approx(28e9)
    assert len(active_runtime.scene.transmitters) == 1
    assert len(active_runtime.scene.receivers) == 1


def test_sync_is_idempotent_and_replaces_managed_devices(active_runtime):
    opts = SolverOptions()
    first = indoor_runtime.sync_indoor_scene_devices("session-1", [_tx()], [_rx()], 28.0, opts)
    second = indoor_runtime.sync_indoor_scene_devices(
        "session-1", [_tx(position=(3, 2, 1.4))], [_rx(position=(4, 1, 1.2))], 28.0, opts
    )
    assert first["deviceSync"]["transmitterCount"] == 1
    assert second["deviceSync"]["transmitterCount"] == 1
    assert len(active_runtime.scene.transmitters) == 1
    assert len(active_runtime.scene.receivers) == 1
    assert next(iter(active_runtime.scene.transmitters.values())).position == pytest.approx((3, 2, 1.4))


def test_sync_rejects_devices_from_different_scene_sessions(active_runtime):
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="belongs to scene session"):
        indoor_runtime.sync_indoor_scene_devices("session-1", [_tx(session="other")], [_rx()], 28.0, SolverOptions())
    assert active_runtime.scene.transmitters == {}


def test_sync_rejects_mixed_scene_level_tx_array_dimensions(active_runtime):
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="same scene-level PlanarArray dimensions"):
        indoor_runtime.sync_indoor_scene_devices(
            "session-1", [_tx(array=(4, 2)), _tx("tx-2", array=(2, 2))], [_rx()], 28.0, SolverOptions()
        )


def test_sync_revalidates_materials_if_carrier_changes(active_runtime):
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="does not support 140 GHz"):
        indoor_runtime.sync_indoor_scene_devices("session-1", [_tx()], [_rx()], 140.0, SolverOptions())
    assert active_runtime.scene.frequency == pytest.approx(28e9)


def test_sync_rolls_back_previous_devices_when_add_fails(active_runtime, monkeypatch):
    opts = SolverOptions()
    indoor_runtime.sync_indoor_scene_devices("session-1", [_tx()], [_rx()], 28.0, opts)
    old_tx = dict(active_runtime.scene.transmitters)
    old_rx = dict(active_runtime.scene.receivers)
    original_add = active_runtime.scene.add

    def fail_new(item):
        if float(item.position[0]) >= 8.0:
            original_add(item)
            raise RuntimeError("intentional fake registration failure")
        original_add(item)

    monkeypatch.setattr(active_runtime.scene, "add", fail_new)
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="intentional fake registration failure"):
        indoor_runtime.sync_indoor_scene_devices(
            "session-1", [_tx(position=(8, 8, 1.4))], [_rx(position=(9, 9, 1.2))], 28.0, opts
        )
    assert set(active_runtime.scene.transmitters) == set(old_tx)
    assert set(active_runtime.scene.receivers) == set(old_rx)
    assert active_runtime.scene.frequency == pytest.approx(28e9)



def test_sync_initial_registration_failure_restores_none_arrays_without_masking_root_error(active_runtime, monkeypatch):
    original_add = active_runtime.scene.add

    def fail_first_registration(item):
        original_add(item)
        raise RuntimeError("intentional initial Sionna device registration failure")

    monkeypatch.setattr(active_runtime.scene, "add", fail_first_registration)
    with pytest.raises(
        indoor_runtime.IndoorSceneActivationError,
        match="intentional initial Sionna device registration failure",
    ):
        indoor_runtime.sync_indoor_scene_devices(
            "session-1", [_tx()], [_rx()], 28.0, SolverOptions()
        )

    # Sionna 2.0.1 rejects `scene.tx_array = None`; rollback must use the
    # backing slot and must preserve the original registration exception.
    assert active_runtime.scene.tx_array is None
    assert active_runtime.scene.rx_array is None
    assert active_runtime.scene.transmitters == {}
    assert active_runtime.scene.receivers == {}
    assert active_runtime.device_names == {"tx": [], "rx": []}


def test_request_model_preserves_indoor_pose_and_requires_both_device_types():
    request = IndoorSceneDeviceSyncRequest(txs=[_tx().model_dump()], rxs=[_rx().model_dump()])
    assert request.txs[0].scenePosition == pytest.approx((1, 2, 1.4))
    assert request.rxs[0].sceneSessionId == "session-1"
    with pytest.raises(Exception):
        IndoorSceneDeviceSyncRequest(txs=[_tx().model_dump()], rxs=[])
