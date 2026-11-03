"""Measurement-Location Ray Tracing: bounded Sionna RT sampling at measured UE locations.

This stage ray-traces a selected scene TX (downlink) to deterministic,
spatially-stratified GPS measurement positions. It reports Sionna total
received power separately from modem SS-RSRP; it deliberately does NOT compute
RSRP residuals until a reference-signal/antenna/power calibration is defined.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from statistics import median
from typing import Any, Optional

import numpy as np

from .measurement_matching import _profile_key, _row_identity, build_radio_identity_profiles
from .measurement_validation import get_measurement_dataset, wgs84_to_scene_enu
from .models import ENUVector
from .scene_build import _geometry_hash, build_scene
from .solver import (
    _TxSpec,
    _beam_target,
    _channel_metrics,
    _device_z,
    _set_rx_array,
    _set_tx_array,
    _solve_batched,
)

MAX_MEASUREMENT_RAYTRACE_SAMPLES = 100


def nr_arfcn_to_ghz(arfcn: Optional[int]) -> Optional[float]:
    """Convert NR-ARFCN to reference frequency using the 3GPP global raster."""
    if arfcn is None:
        return None
    n = int(arfcn)
    if 0 <= n <= 599_999:
        return n * 0.005 / 1000.0
    if 600_000 <= n <= 2_016_666:
        return (3000.0 + (n - 600_000) * 0.015) / 1000.0
    if 2_016_667 <= n <= 3_279_165:
        return (24_250.08 + (n - 2_016_667) * 0.06) / 1000.0
    return None


def _median_or_none(values: list[float]) -> Optional[float]:
    clean = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    return float(median(clean)) if clean else None


def select_measurement_sample_points(
    dataset: dict[str, Any],
    *,
    profile_id: str,
    anchor_latitude: float,
    anchor_longitude: float,
    scene_bounds: Optional[dict[str, float]],
    sample_count: int,
) -> dict[str, Any]:
    """Aggregate duplicate GPS fixes and pick deterministic time-stratified locations."""
    profiles = build_radio_identity_profiles(dataset)
    profile = next((p for p in profiles if p["profileId"] == profile_id), None)
    if profile is None:
        raise ValueError("Selected radio identity profile is not present in this dataset")

    grouped: dict[tuple[float, float], dict[str, Any]] = {}
    for index, (raw, quality) in enumerate(zip(dataset["rows"], dataset["qualityRows"])):
        ident = _row_identity(raw, quality)
        key = _profile_key(
            ident["rat"].upper(), ident["pci"], ident["band"], ident["arfcn"],
            ident["anchorCellId"] or "", ident["anchorPci"], ident["anchorEarfcn"],
        ) if ident["pci"] is not None else None
        if key != profile_id or not quality.get("eligibleForSpatialValidation"):
            continue
        lat, lon = quality.get("lat"), quality.get("lon")
        if lat is None or lon is None:
            continue
        pos_key = (round(float(lat), 7), round(float(lon), 7))
        entry = grouped.setdefault(pos_key, {
            "latitude": [], "longitude": [], "rsrp": [], "rsrq": [], "sinr": [],
            "timestamps": [], "rowIndexes": [],
        })
        entry["latitude"].append(float(lat))
        entry["longitude"].append(float(lon))
        if quality.get("rsrpDbm") is not None:
            entry["rsrp"].append(float(quality["rsrpDbm"]))
        if quality.get("rsrqDb") is not None:
            entry["rsrq"].append(float(quality["rsrqDb"]))
        if quality.get("sinrDb") is not None:
            entry["sinr"].append(float(quality["sinrDb"]))
        if quality.get("timestampUtc"):
            entry["timestamps"].append(str(quality["timestampUtc"]))
        entry["rowIndexes"].append(index)

    points: list[dict[str, Any]] = []
    outside = 0
    for (lat_key, lon_key), item in grouped.items():
        lat = float(np.mean(item["latitude"]))
        lon = float(np.mean(item["longitude"]))
        east, north = wgs84_to_scene_enu(lat, lon, anchor_latitude, anchor_longitude)
        inside = None
        if scene_bounds:
            inside = (
                float(scene_bounds["xMin"]) <= east <= float(scene_bounds["xMax"])
                and float(scene_bounds["yMin"]) <= north <= float(scene_bounds["yMax"])
            )
            if not inside:
                outside += 1
                continue
        timestamps = sorted(item["timestamps"])
        points.append({
            "latitude": lat,
            "longitude": lon,
            "eastM": float(east),
            "northM": float(north),
            "rsrpDbm": _median_or_none(item["rsrp"]),
            "rsrqDb": _median_or_none(item["rsrq"]),
            "sinrDb": _median_or_none(item["sinr"]),
            "sourceRowCount": len(item["rowIndexes"]),
            "sourceRows": [int(i + 1) for i in item["rowIndexes"]],
            "firstTimestampUtc": timestamps[0] if timestamps else None,
            "lastTimestampUtc": timestamps[-1] if timestamps else None,
            "withinSceneEnvelope": inside,
        })
    points.sort(key=lambda p: (p["firstTimestampUtc"] or "", p["eastM"], p["northM"]))
    if not points:
        raise ValueError("No eligible measurement locations remain inside the active scene envelope")

    count = min(int(sample_count), len(points), MAX_MEASUREMENT_RAYTRACE_SAMPLES)
    if len(points) > count:
        indexes = np.linspace(0, len(points) - 1, count).round().astype(int).tolist()
        # np.linspace rounding is normally unique for n>=count; keep stable uniqueness defensively.
        indexes = list(dict.fromkeys(indexes))
        if len(indexes) < count:
            for index in range(len(points)):
                if index not in indexes:
                    indexes.append(index)
                if len(indexes) == count:
                    break
        selected = [points[i] for i in sorted(indexes)]
    else:
        selected = points

    return {
        "profile": profile,
        "allDistinctEligiblePositions": len(grouped),
        "eligiblePositionsInsideScene": len(points),
        "excludedOutsideScenePositions": outside,
        "sampledLocations": selected,
        "sampleStrategy": "Deterministic temporal stratification over unique GPS positions",
    }


def run_measurement_location_raytrace(dataset_id: str, req, cancel_event=None, progress=None) -> dict[str, Any]:
    """Run one batched downlink PathSolver dispatch for sampled field locations.

    Cancellation is cooperative: it is checked before and after the single
    batched PathSolver dispatch. The native GPU operation itself cannot be
    interrupted safely once Sionna/Mitsuba has entered it.
    """
    def check_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Measurement ray trace cancelled; no partial result was saved")

    def report(fraction: float, message: str):
        if progress is not None:
            progress(fraction, message)

    check_cancelled()
    report(0.08, "Selecting deterministic measurement sample")
    dataset = get_measurement_dataset(dataset_id)
    if dataset is None:
        raise KeyError(dataset_id)
    sample = select_measurement_sample_points(
        dataset,
        profile_id=req.profileId,
        anchor_latitude=req.anchorLatitude,
        anchor_longitude=req.anchorLongitude,
        scene_bounds=req.sceneBounds.model_dump() if req.sceneBounds else None,
        sample_count=req.sampleCount,
    )
    profile = sample["profile"]
    tx = req.tx
    check_cancelled()
    report(0.18, f"Prepared {len(sample['sampledLocations'])} GPS locations; building RT scene")

    # Prefer the measured NR-ARFCN-derived carrier when present. This prevents
    # silently ray-tracing a 3.5 GHz default while the modem context is another
    # n78 carrier. The scene frequency is explicit in the response.
    measured_frequency = nr_arfcn_to_ghz(profile.get("arfcn"))
    effective_frequency = measured_frequency if measured_frequency is not None else float(req.freqGhz)
    warnings = [
        "Sionna reports total received power across resolved propagation paths; modem SS-RSRP is a reference-signal measurement. They are displayed side by side but no residual/RMSE is computed.",
        "Receiver height is modelled as fixed scene AGL because GPS altitude vertical datum has not been confirmed.",
        "The selected scene TX conducted power, antenna pattern/array and beam azimuth are used as configured. Verify their physical reference and calibration before radiometric comparison.",
        "This is downlink BS→UE ray tracing at measured positions. It does not simulate the Quectel reference-signal estimator or LTE/NR NSA protocol stack.",
    ]
    if measured_frequency is not None and abs(float(req.freqGhz) - measured_frequency) > 0.01:
        warnings.append(
            f"App RF frequency ({float(req.freqGhz):.4f} GHz) differs from the selected measurement NR-ARFCN-derived frequency ({measured_frequency:.4f} GHz); the measurement-derived frequency is used for this RT run."
        )
    if tx.carrierFrequencyGhz is not None and abs(float(tx.carrierFrequencyGhz) - effective_frequency) > 0.005:
        warnings.append(
            f"Selected TX inventory carrier ({float(tx.carrierFrequencyGhz):.4f} GHz) differs from the measurement carrier ({effective_frequency:.4f} GHz). Candidate identity is not confirmed."
        )
    if tx.powerReference == "eirp":
        warnings.append(
            "The selected TX power is labelled EIRP in inventory metadata, but Sionna receives tx.powerDbm while the configured antenna pattern/array is also active. Check the reference and gain accounting to avoid double-counting antenna gain."
        )
    elif tx.powerReference is None:
        warnings.append(
            "TX power reference is unspecified. Confirm whether the configured tx.powerDbm is conducted power or EIRP before interpreting absolute received power."
        )
    if profile.get("band") is not None:
        tx_band_text = str(tx.frequencyBand or "").lower()
        import re
        match = re.search(r"(?:n|b)?\s*(\d{1,3})\b", tx_band_text)
        tx_band = int(match.group(1)) if match else None
        if tx_band is not None and tx_band != int(profile["band"]):
            warnings.append(f"Selected TX band {tx.frequencyBand} does not match measured band {profile['band']}.")

    buildings = req.buildings
    scene = build_scene(buildings, effective_frequency, req.materials)
    resolved_tx_z = _device_z(tx.enu, tx.height, buildings, getattr(tx, "heightReference", None))
    tx_pos = [float(tx.enu.x), float(tx.enu.y), float(resolved_tx_z)]
    n_tx_ant = _set_tx_array(scene, tx.antennaArraySize, req.options)
    n_rx_ant = _set_rx_array(scene, req.rxArraySize, req.options)
    tx_spec = _TxSpec(
        pos=tx_pos,
        beam=_beam_target(tx_pos, tx.beamsteeringAzimuth, tx.beamsteeringElevation),
        power_dbm=float(tx.powerDbm),
        id=tx.id,
        name=tx.name,
    )
    rx_positions = [
        [float(p["eastM"]), float(p["northM"]), float(req.rxHeightM)]
        for p in sample["sampledLocations"]
    ]
    rx_velocities = [[0.0, 0.0, 0.0] for _ in rx_positions]
    check_cancelled()
    report(0.32, "Running batched Sionna PathSolver on GPU")
    batched = _solve_batched(
        scene, [tx_spec], rx_positions, rx_velocities, n_tx_ant,
        max_depth=int(req.maxDepth), opts=req.options,
    )
    check_cancelled()
    report(0.88, "Collecting path metrics and RF configuration snapshot")

    # Capture the exact effective configuration sent to PathSolver.
    # This records execution settings; it does not claim physical calibration.
    height_reference_input = getattr(tx, "heightReference", None)
    height_reference_effective = height_reference_input or "legacy_roof_plus_height"
    tx_array_size = [int(tx.antennaArraySize[0]), int(tx.antennaArraySize[1])]
    rx_array_size = [int(req.rxArraySize[0]), int(req.rxArraySize[1])]
    material_payload = [m.model_dump() if hasattr(m, "model_dump") else dict(m) for m in req.materials]
    material_counts = dict(sorted(Counter(str(getattr(b, "material", "itu_concrete")) for b in buildings).items()))
    scene_geometry_fingerprint = _geometry_hash(buildings, effective_frequency, req.materials)
    sampled_location_payload = [
        {"lat": round(float(p["latitude"]), 7), "lon": round(float(p["longitude"]), 7), "sourceRows": p["sourceRows"]}
        for p in sample["sampledLocations"]
    ]
    sampled_location_fingerprint = hashlib.sha256(
        json.dumps(sampled_location_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    rf_configuration = {
        "schemaVersion": "rf-config-snapshot-v1",
        "frequency": {
            "effectiveGhz": float(effective_frequency),
            "source": "NR-ARFCN raster" if measured_frequency is not None else "application RF frequency",
            "applicationGhz": float(req.freqGhz),
            "measurementArfcn": profile.get("arfcn"),
        },
        "tx": {
            "id": tx.id, "name": tx.name, "site": tx.site,
            "transmitterLabel": tx.transmitterLabel,
            "frequencyBand": tx.frequencyBand,
            "carrierFrequencyGhzMetadata": tx.carrierFrequencyGhz,
            "sourcePowerDbmMetadata": tx.sourcePowerDbm,
            "positionEnuM": {"east": float(tx.enu.x), "north": float(tx.enu.y), "up": float(resolved_tx_z)},
            "configuredHeightM": float(tx.height),
            "heightReferenceInput": height_reference_input,
            "heightResolution": height_reference_effective,
            "powerDbm": float(tx.powerDbm), "powerReference": tx.powerReference,
            "antennaModelMetadata": tx.antennaModel,
            "antennaModelMetadataAppliedAsCustomPattern": False,
            "antennaGainDbiMetadata": tx.antennaGainDbi,
            "antennaGainDbiMetadataAppliedSeparately": False,
            "arraySize": tx_array_size, "arrayPorts": int(n_tx_ant),
            "pattern": req.options.txPattern, "polarization": req.options.txPolarization,
            "elementSpacingLambda": 0.5,
            "beamAzimuthDeg": float(tx.beamsteeringAzimuth),
            "beamElevationDeg": float(tx.beamsteeringElevation),
            "mechanicalDowntiltDegMetadata": tx.mechanicalDowntiltDeg,
            "electricalDowntiltDegMetadata": tx.electricalDowntiltDeg,
            "panelDowntiltMetadataAppliedToBeam": False,
        },
        "rx": {
            "heightAglM": float(req.rxHeightM), "arraySize": rx_array_size,
            "arrayPorts": int(n_rx_ant), "pattern": req.options.rxPattern,
            "polarization": req.options.rxPolarization, "elementSpacingLambda": 0.5,
        },
        "pathSolver": {
            "maxDepth": int(req.maxDepth),
            "pathSamplesPerSource": int(req.options.pathSamplesPerSource),
            "pathSeed": int(req.options.pathSeed),
            "los": bool(req.options.los),
            "specularReflection": bool(req.options.specularReflection),
            "diffuseReflection": bool(req.options.diffuseReflection),
            "refraction": bool(req.options.refraction),
            "diffraction": bool(req.options.diffraction),
            "edgeDiffraction": bool(req.options.edgeDiffraction),
            "syntheticArray": True,
        },
        "scene": {
            "geometryFingerprint": scene_geometry_fingerprint,
            "buildingCount": len(buildings),
            "buildingMaterialCounts": material_counts,
            "materialOverrides": material_payload,
            "anchorLatitude": float(req.anchorLatitude),
            "anchorLongitude": float(req.anchorLongitude),
            "sceneBounds": req.sceneBounds.model_dump() if req.sceneBounds else None,
        },
        "sampling": {
            "profileId": req.profileId,
            "sampleCountRequested": int(req.sampleCount),
            "sampleCountReturned": len(sample["sampledLocations"]),
            "locationFingerprint": sampled_location_fingerprint,
            "rxHeightAglM": float(req.rxHeightM),
            "strategy": sample["sampleStrategy"],
        },
    }
    canonical_config = json.dumps(rf_configuration, sort_keys=True, separators=(",", ":"), allow_nan=False)
    configuration_fingerprint = hashlib.sha256(canonical_config.encode("utf-8")).hexdigest()
    config_warnings = []
    if tx.powerReference is None:
        config_warnings.append("TX power reference is unspecified (conducted power vs EIRP). Absolute received power is not publication-ready.")
    elif tx.powerReference == "eirp":
        config_warnings.append("TX power is marked as EIRP while the antenna pattern/array is also active; verify gain accounting to avoid double counting.")
    if tx.sourcePowerDbm is not None and abs(float(tx.sourcePowerDbm) - float(tx.powerDbm)) > 0.1:
        config_warnings.append("Imported sourcePowerDbm differs from the tx.powerDbm value actually passed to Sionna; verify which power is authoritative.")
    if not tx.antennaModel:
        config_warnings.append("No physical antenna model is recorded in TX inventory metadata; the selected generic Sionna pattern is used.")
    else:
        config_warnings.append("TX antennaModel is inventory metadata only; Sionna uses the selected generic scene antenna pattern, not an imported custom antenna pattern.")
    if tx.antennaGainDbi is None:
        config_warnings.append("TX antenna gain metadata is missing; do not interpret configured TX power as calibrated EIRP.")
    if tx.mechanicalDowntiltDeg is None and tx.electricalDowntiltDeg is None:
        config_warnings.append("Mechanical/electrical downtilt metadata is missing; beam elevation alone does not document the real panel tilt.")
    else:
        config_warnings.append("Mechanical/electrical downtilt metadata is recorded but not applied automatically; the Sionna beam direction uses beamsteeringElevationDeg.")
    if height_reference_input is None:
        config_warnings.append("TX heightReference is unset: legacy roof+height resolution was used. Confirm whether the entered tower height is AGL, above-roof, or scene Z.")
    if tx_array_size == [1, 1]:
        config_warnings.append("TX array is 1x1: no multi-element array aperture is represented, even if the element pattern is directional.")
    if rx_array_size == [1, 1]:
        config_warnings.append("RX array is 1x1 isotropic/selected element model; no handset multi-antenna diversity is represented.")
    rf_configuration["configurationFingerprint"] = configuration_fingerprint
    rf_configuration["physicalCalibrationStatus"] = "incomplete" if config_warnings else "metadata-complete-not-externally-validated"
    rf_configuration["physicalCalibrationWarnings"] = config_warnings

    results: list[dict[str, Any]] = []
    for index, point in enumerate(sample["sampledLocations"]):
        paths, max_doppler = batched[index][0]
        metrics = _channel_metrics(paths)
        total_rx = float(metrics.totalRxPowerDbm) if paths else None
        channel_gain = total_rx - float(tx.powerDbm) if total_rx is not None else None
        results.append({
            "sampleIndex": index + 1,
            "sourceRows": point["sourceRows"],
            "sourceRowCount": point["sourceRowCount"],
            "firstTimestampUtc": point["firstTimestampUtc"],
            "lastTimestampUtc": point["lastTimestampUtc"],
            "latitude": point["latitude"],
            "longitude": point["longitude"],
            "eastM": point["eastM"],
            "northM": point["northM"],
            "rxHeightAglM": float(req.rxHeightM),
            "measuredRsrpMedianDbm": point["rsrpDbm"],
            "measuredRsrqMedianDb": point["rsrqDb"],
            "measuredSinrMedianDb": point["sinrDb"],
            "simulatedTotalRxPowerDbm": total_rx,
            "simulatedChannelGainDb": channel_gain,
            "losStatus": metrics.losStatus,
            "numPaths": metrics.numPaths,
            "rmsDelaySpreadNs": metrics.rmsDelaySpreadNs,
            "strongestPathPowerDbm": metrics.strongestPathPowerDbm if paths else None,
            "strongestPathType": metrics.strongestPathType,
            "maxDopplerHz": float(max_doppler),
            "withinSceneEnvelope": point["withinSceneEnvelope"],
            "simulationValid": bool(paths),
            "configurationFingerprint": configuration_fingerprint,
        })

    valid_rx = [r["simulatedTotalRxPowerDbm"] for r in results if r["simulatedTotalRxPowerDbm"] is not None]
    gains = [r["simulatedChannelGainDb"] for r in results if r["simulatedChannelGainDb"] is not None]
    check_cancelled()
    report(0.98, "Finalizing measurement ray-trace result")
    return {
        "datasetId": dataset_id,
        "filename": dataset["filename"],
        "profile": {
            "profileId": profile["profileId"],
            "rat": profile["rat"], "pci": profile["pci"],
            "band": profile["band"], "arfcn": profile["arfcn"],
            "lteAnchorCellId": profile["lteAnchorCellId"],
            "lteAnchorPci": profile["lteAnchorPci"],
            "eligibleRows": profile["eligibleRows"],
        },
        "transmitter": {
            "txId": tx.id, "txName": tx.name, "site": tx.site,
            "frequencyBand": tx.frequencyBand,
            "inventoryCarrierFrequencyGhz": tx.carrierFrequencyGhz,
            "txPowerDbm": float(tx.powerDbm),
            "powerReference": tx.powerReference,
            "antennaGainDbi": tx.antennaGainDbi,
            "beamAzimuthDeg": float(tx.beamsteeringAzimuth),
            "txPositionEnuM": {"east": float(tx.enu.x), "north": float(tx.enu.y), "up": float(tx_pos[2])},
        },
        "frequencyGhz": float(effective_frequency),
        "frequencySource": "NR-ARFCN raster" if measured_frequency is not None else "application RF frequency",
        "configuredApplicationFrequencyGhz": float(req.freqGhz),
        "maxDepth": int(req.maxDepth),
        "rxHeightAglM": float(req.rxHeightM),
        "rxArraySize": list(req.rxArraySize),
        "rfConfiguration": rf_configuration,
        "configurationFingerprint": configuration_fingerprint,
        "sampleStrategy": sample["sampleStrategy"],
        "allDistinctEligiblePositions": sample["allDistinctEligiblePositions"],
        "eligiblePositionsInsideScene": sample["eligiblePositionsInsideScene"],
        "excludedOutsideScenePositions": sample["excludedOutsideScenePositions"],
        "sampleCountRequested": int(req.sampleCount),
        "sampleCountReturned": len(results),
        "validSimulationCount": sum(1 for r in results if r["simulationValid"]),
        "noPathCount": sum(1 for r in results if not r["simulationValid"]),
        "medianSimulatedTotalRxPowerDbm": _median_or_none(valid_rx),
        "medianSimulatedChannelGainDb": _median_or_none(gains),
        "medianMeasuredRsrpDbm": _median_or_none([r["measuredRsrpMedianDbm"] for r in results]),
        "results": results,
        "warnings": warnings,
    }
