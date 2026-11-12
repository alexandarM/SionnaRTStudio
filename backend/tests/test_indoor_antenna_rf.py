from backend.models import Transmitter


def _tx(**extra):
    data = {
        "id": "indoor-tx",
        "name": "Indoor AP",
        "enu": {"x": 0.0, "y": 0.0, "z": 0.0},
        "powerDbm": 23.0,
        "antennaArraySize": [8, 4],
        "beamsteeringAzimuth": 15.0,
        "beamsteeringElevation": -5.0,
    }
    data.update(extra)
    return Transmitter.model_validate(data)


def test_indoor_beam_steering_frame_is_preserved_separately():
    tx = _tx(
        beamSteeringFrame="device_local",
        indoorBeamSteering={"azimuthDeg": 25.0, "elevationDeg": 10.0},
    )
    assert tx.beamSteeringFrame == "device_local"
    assert tx.indoorBeamSteering.azimuthDeg == 25.0
    assert tx.indoorBeamSteering.elevationDeg == 10.0
    assert tx.antennaArraySize == (8, 4)
    # Existing world ENU steering remains untouched by the indoor edit.
    assert tx.beamsteeringAzimuth == 15.0
    assert tx.beamsteeringElevation == -5.0


def test_legacy_outdoor_beam_frame_default_is_unchanged():
    tx = _tx()
    assert tx.beamSteeringFrame == "world_enu"


def test_explicit_outdoor_beam_frame_round_trips():
    tx = _tx(beamSteeringFrame="world_enu")
    assert tx.model_dump()["beamSteeringFrame"] == "world_enu"


def test_indoor_steering_does_not_replace_outdoor_compass_angles():
    tx = _tx(
        beamsteeringAzimuth=120.0,
        beamsteeringElevation=-7.0,
        beamSteeringFrame="device_local",
        indoorBeamSteering={"azimuthDeg": -20.0, "elevationDeg": 5.0},
    )
    dumped = tx.model_dump()
    assert dumped["beamsteeringAzimuth"] == 120.0
    assert dumped["beamsteeringElevation"] == -7.0
    assert dumped["indoorBeamSteering"] == {"azimuthDeg": -20.0, "elevationDeg": 5.0}
