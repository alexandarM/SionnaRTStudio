"""Measurement radio-identity profiling and transmitter-sector candidates.

This module deliberately does NOT auto-assign a measured PCI to a physical
transmitter. It profiles the observed NR identity/context and ranks scene TXs
using geometry/boresight/frequency metadata as review aids only. A manual
mapping must be explicitly confirmed by the user before it can be reused by a
later simulation-sampling stage.
"""
from __future__ import annotations

import hashlib
import math
from collections import Counter, defaultdict
from statistics import median
from typing import Any, Optional

from .measurement_validation import get_measurement_dataset, wgs84_to_scene_enu


def _raw_value(raw: dict[str, Any], aliases: tuple[str, ...]) -> str:
    normalized = {str(k).strip().lower(): v for k, v in raw.items()}
    for alias in aliases:
        value = normalized.get(alias.lower())
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return ""


def _number(value: Any) -> Optional[float]:
    try:
        if value is None or str(value).strip() == "":
            return None
        number = float(str(value).strip().replace(",", "."))
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _integer(value: Any) -> Optional[int]:
    number = _number(value)
    return int(number) if number is not None and number.is_integer() else None


def _profile_key(rat: str, pci: int, band: Optional[int], arfcn: Optional[int],
                 anchor_cell_id: str, anchor_pci: Optional[int], anchor_earfcn: Optional[int]) -> str:
    parts = [rat.upper(), str(pci), str(band), str(arfcn), anchor_cell_id.upper(),
             str(anchor_pci), str(anchor_earfcn)]
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:12]
    return f"radioctx_{digest}"


def _bearing_deg(east_delta: float, north_delta: float) -> float:
    return (math.degrees(math.atan2(east_delta, north_delta)) + 360.0) % 360.0


def _angle_difference_deg(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _band_number(value: Any) -> Optional[int]:
    """Read n78/B78/78-style inventory metadata without guessing from names."""
    text = str(value or "").strip().lower()
    if not text:
        return None
    import re
    match = re.search(r"(?:n|b)?\s*(\d{1,3})\b", text)
    return int(match.group(1)) if match else None


def _percentile(values: list[float], p: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * p
    lo, hi = math.floor(position), math.ceil(position)
    if lo == hi:
        return float(ordered[lo])
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo))


def _row_identity(raw: dict[str, Any], quality: dict[str, Any]) -> dict[str, Any]:
    rat = str(quality.get("rat") or "").strip()
    pci = quality.get("pci")
    band = _integer(quality.get("band"))
    arfcn = _integer(quality.get("arfcn"))
    anchor_cell_id = _raw_value(raw, ("cell_id", "cellid", "eci", "ecgi")).upper()
    anchor_pci = _integer(_raw_value(raw, ("anchor_pci", "lte_anchor_pci")))
    anchor_band = _raw_value(raw, ("anchor_band", "lte_anchor_band"))
    anchor_earfcn = _integer(_raw_value(raw, ("earfcn", "anchor_earfcn")))
    return {
        "rat": rat,
        "pci": int(pci) if pci is not None else None,
        "band": band,
        "arfcn": arfcn,
        "anchorCellId": anchor_cell_id or None,
        "anchorPci": anchor_pci,
        "anchorBand": anchor_band or None,
        "anchorEarfcn": anchor_earfcn,
    }


def build_radio_identity_profiles(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    """Group measurements by NR identity plus observed LTE-anchor context.

    In NR NSA logs the CSV `cell_id` and `earfcn` fields are sourced from the
    LTE serving-cell line. They are therefore exposed explicitly as LTE-anchor
    context, not mislabeled as an NR gNodeB global identity.
    """
    groups: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for index, (raw, quality) in enumerate(zip(dataset["rows"], dataset["qualityRows"])):
        ident = _row_identity(raw, quality)
        if not ident["rat"] or ident["pci"] is None:
            continue
        key = (ident["rat"].upper(), ident["pci"], ident["band"], ident["arfcn"],
               ident["anchorCellId"] or "", ident["anchorPci"], ident["anchorEarfcn"])
        groups[key].append({"rowIndex": index, "raw": raw, "quality": quality, "identity": ident})

    profiles: list[dict[str, Any]] = []
    for key, items in groups.items():
        first = items[0]["identity"]
        valid_items = [x for x in items if x["quality"].get("eligibleForSpatialValidation")]
        rsrp = [float(x["quality"]["rsrpDbm"]) for x in valid_items if x["quality"].get("rsrpDbm") is not None]
        sinr = [float(x["quality"]["sinrDb"]) for x in valid_items if x["quality"].get("sinrDb") is not None]
        positions = {
            (round(float(x["quality"]["lat"]), 7), round(float(x["quality"]["lon"]), 7))
            for x in items if x["quality"].get("locationValid")
        }
        timestamps = [x["quality"].get("timestampUtc") for x in items if x["quality"].get("timestampUtc")]
        profile_id = _profile_key(*key)
        profiles.append({
            "profileId": profile_id,
            "rat": first["rat"],
            "pci": first["pci"],
            "band": first["band"],
            "arfcn": first["arfcn"],
            "lteAnchorCellId": first["anchorCellId"],
            "lteAnchorPci": first["anchorPci"],
            "lteAnchorBand": first["anchorBand"],
            "lteAnchorEarfcn": first["anchorEarfcn"],
            "rowCount": len(items),
            "eligibleRows": len(valid_items),
            "distinctGpsPositions": len(positions),
            "rsrpMedianDbm": float(median(rsrp)) if rsrp else None,
            "rsrpP05Dbm": _percentile(rsrp, 0.05),
            "rsrpP95Dbm": _percentile(rsrp, 0.95),
            "sinrMedianDb": float(median(sinr)) if sinr else None,
            "firstTimestampUtc": min(timestamps) if timestamps else None,
            "lastTimestampUtc": max(timestamps) if timestamps else None,
        })
    profiles.sort(key=lambda p: (p["rowCount"], p["eligibleRows"]), reverse=True)
    return profiles


def _candidate_tx_metrics(tx: dict[str, Any], points: list[tuple[float, float]],
                          measurement_band: Optional[int]) -> dict[str, Any]:
    tx_id = str(tx.get("id") or "")
    tx_name = str(tx.get("name") or tx_id or "Transmitter")
    enu = tx.get("enu") or {}
    tx_e = _number(enu.get("x"))
    tx_n = _number(enu.get("y"))
    if tx_e is None or tx_n is None:
        return {
            "txId": tx_id, "txName": tx_name, "distanceAvailable": False,
            "warning": "Transmitter has no valid ENU position.",
        }

    distances: list[float] = []
    bearings: list[float] = []
    for east, north in points:
        de, dn = east - tx_e, north - tx_n
        distances.append(math.hypot(de, dn))
        if math.hypot(de, dn) > 0.01:
            bearings.append(_bearing_deg(de, dn))

    # Circular mean avoids the 359°/1° wraparound problem.
    if bearings:
        sin_sum = sum(math.sin(math.radians(v)) for v in bearings)
        cos_sum = sum(math.cos(math.radians(v)) for v in bearings)
        bearing_mean = (math.degrees(math.atan2(sin_sum, cos_sum)) + 360.0) % 360.0
    else:
        bearing_mean = None
    beam_az = _number(tx.get("beamsteeringAzimuth"))
    azimuth_delta = _angle_difference_deg(bearing_mean, beam_az) if bearing_mean is not None and beam_az is not None else None
    tx_band = _band_number(tx.get("frequencyBand"))
    frequency_match: Optional[bool] = None if tx_band is None or measurement_band is None else tx_band == measurement_band
    return {
        "txId": tx_id,
        "txName": tx_name,
        "site": tx.get("site"),
        "frequencyBand": tx.get("frequencyBand"),
        "carrierFrequencyGhz": tx.get("carrierFrequencyGhz"),
        "txEastM": tx_e,
        "txNorthM": tx_n,
        "measurementPointCount": len(points),
        "distanceAvailable": True,
        "distanceMinM": min(distances) if distances else None,
        "distanceP50M": _percentile(distances, 0.50),
        "distanceP90M": _percentile(distances, 0.90),
        "distanceMaxM": max(distances) if distances else None,
        "measurementBearingMeanDeg": bearing_mean,
        "beamAzimuthDeg": beam_az,
        "boresightDeltaDeg": azimuth_delta,
        "frequencyBandMatch": frequency_match,
        "rankingMeaning": "Geometry/metadata candidate only; not proof of serving-cell identity or RF coverage.",
    }


def compute_measurement_matching_audit(
    dataset_id: str,
    *,
    anchor_latitude: float,
    anchor_longitude: float,
    transmitters: list[dict[str, Any]],
    rat: Optional[str] = "NR5G-NSA",
    profile_id: Optional[str] = None,
    pci: Optional[int] = None,
    band: Optional[int] = None,
    arfcn: Optional[int] = None,
    scene_bounds: Optional[dict[str, float]] = None,
    preview_limit: int = 12,
) -> dict[str, Any]:
    dataset = get_measurement_dataset(dataset_id)
    if dataset is None:
        raise KeyError(dataset_id)
    if not (-90 <= anchor_latitude <= 90 and -180 <= anchor_longitude <= 180):
        raise ValueError("Scene anchor must be valid WGS84 latitude/longitude")

    profiles = build_radio_identity_profiles(dataset)
    selected = next((p for p in profiles if profile_id and p["profileId"] == profile_id), None)
    if selected is None:
        candidates = profiles
        if rat:
            candidates = [p for p in candidates if p["rat"].upper() == rat.upper()]
        if pci is not None:
            candidates = [p for p in candidates if p["pci"] == pci]
        if band is not None:
            candidates = [p for p in candidates if p["band"] == band]
        if arfcn is not None:
            candidates = [p for p in candidates if p["arfcn"] == arfcn]
        selected = candidates[0] if candidates else None

    warnings = [
        "For NR5G-NSA records, cell_id/earfcn originate from the LTE serving-cell (anchor) line in the captured QENG record. They are not the NR gNodeB global identity.",
        "PCI is not globally unique. The same PCI can be reused by different physical cells; PCI/ARFCN/band plus geography narrows candidates but does not prove site identity.",
        "TX candidates are ranked only by frequency metadata, distance and boresight geometry. No automatic PCI-to-transmitter assignment is made.",
        "Measured modem RSRP is not directly comparable with Sionna total received power. This workflow performs identity/geospatial matching only; radiometric equivalence must be defined before statistical validation.",
    ]
    if not selected:
        return {
            "datasetId": dataset_id, "filename": dataset["filename"],
            "identityProfiles": profiles[:100], "selectedProfile": None,
            "candidateTransmitters": [], "preview": [], "warnings": warnings + ["No measurement identity matches the selected filters."],
        }

    selected_rows: list[dict[str, Any]] = []
    distinct_positions: dict[tuple[float, float], tuple[float, float]] = {}
    rsrp_values: list[float] = []
    for index, (raw, quality) in enumerate(zip(dataset["rows"], dataset["qualityRows"])):
        ident = _row_identity(raw, quality)
        current_key = _profile_key(
            ident["rat"].upper(), ident["pci"], ident["band"], ident["arfcn"],
            ident["anchorCellId"] or "", ident["anchorPci"], ident["anchorEarfcn"],
        ) if ident["pci"] is not None else None
        if current_key != selected["profileId"]:
            continue
        if not quality.get("eligibleForSpatialValidation"):
            continue
        east, north = wgs84_to_scene_enu(float(quality["lat"]), float(quality["lon"]), anchor_latitude, anchor_longitude)
        within = None
        if scene_bounds:
            within = (float(scene_bounds["xMin"]) <= east <= float(scene_bounds["xMax"])
                      and float(scene_bounds["yMin"]) <= north <= float(scene_bounds["yMax"]))
        item = {
            "rowIndex": index,
            "timestampUtc": quality.get("timestampUtc"),
            "rat": ident["rat"], "pci": ident["pci"], "band": ident["band"], "arfcn": ident["arfcn"],
            "lteAnchorCellId": ident["anchorCellId"], "lteAnchorPci": ident["anchorPci"],
            "lteAnchorEarfcn": ident["anchorEarfcn"],
            "rsrpDbm": quality.get("rsrpDbm"), "rsrqDb": quality.get("rsrqDb"), "sinrDb": quality.get("sinrDb"),
            "latitude": quality.get("lat"), "longitude": quality.get("lon"),
            "eastM": east, "northM": north, "withinSceneEnvelope": within,
        }
        selected_rows.append(item)
        if quality.get("rsrpDbm") is not None:
            rsrp_values.append(float(quality["rsrpDbm"]))
        pos_key = (round(float(quality["lat"]), 7), round(float(quality["lon"]), 7))
        distinct_positions[pos_key] = (east, north)

    points = list(distinct_positions.values())
    candidate_metrics = [
        _candidate_tx_metrics(tx, points, selected.get("band"))
        for tx in transmitters[:128]
    ]
    # A deterministic heuristic ordering; this never selects/assigns a TX.
    candidate_metrics.sort(key=lambda c: (
        0 if c.get("frequencyBandMatch") is True else 1 if c.get("frequencyBandMatch") is None else 2,
        c.get("boresightDeltaDeg") if c.get("boresightDeltaDeg") is not None else 999.0,
        c.get("distanceP50M") if c.get("distanceP50M") is not None else float("inf"),
    ))

    anchor_contexts = Counter(
        (str(x["lteAnchorCellId"] or "—"), x["lteAnchorPci"], x["lteAnchorEarfcn"])
        for x in selected_rows
    )
    profile_out = dict(selected)
    profile_out.update({
        "eligibleRows": len(selected_rows),
        "distinctGpsPositions": len(distinct_positions),
        "rsrpMedianDbm": float(median(rsrp_values)) if rsrp_values else None,
        "rsrpP05Dbm": _percentile(rsrp_values, 0.05),
        "rsrpP95Dbm": _percentile(rsrp_values, 0.95),
        "lteAnchorContexts": [
            {"cellId": cell, "pci": anchor_pci, "earfcn": earfcn, "count": count}
            for (cell, anchor_pci, earfcn), count in anchor_contexts.most_common(20)
        ],
    })
    sample = selected_rows
    if len(sample) > max(1, min(preview_limit, 100)):
        stride = (len(sample) - 1) / (min(preview_limit, 100) - 1) if preview_limit > 1 else 1
        sample = [sample[round(i * stride)] for i in range(min(preview_limit, 100))]

    return {
        "datasetId": dataset_id,
        "filename": dataset["filename"],
        "anchor": {"latitude": anchor_latitude, "longitude": anchor_longitude},
        "sceneBounds": scene_bounds,
        "identityProfiles": profiles[:100],
        "totalIdentityProfiles": len(profiles),
        "selectedProfile": profile_out,
        "candidateTransmitters": candidate_metrics,
        "preview": sample,
        "warnings": warnings,
    }
