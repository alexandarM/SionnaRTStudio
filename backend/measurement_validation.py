"""Field Measurement Import & Quality Control: import, quality-control and inspect Quectel/GPS field measurements.

The importer deliberately preserves every original CSV field and row. It adds
validation flags rather than rewriting sentinel values or silently dropping
records. The initial implementation supports the project's exported Quectel schema
and common aliases for the core time, position and RF fields.
"""
from __future__ import annotations

import csv
import io
import math
import re
import threading
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from statistics import mean, median, pstdev
from typing import Any, Optional

MAX_CSV_BYTES = 25 * 1024 * 1024
MAX_DATASETS = 8

ALIASES = {
    "timestamp_utc": ("timestamp_utc", "utc_timestamp", "timestamp", "datetime", "time"),
    "timestamp_local": ("timestamp_local", "local_timestamp", "local_time"),
    "rat": ("rat", "radio_access_technology", "technology"),
    "pci": ("pci", "physical_cell_id"),
    "band": ("band", "nr_band", "lte_band"),
    "arfcn": ("arfcn", "nrarfcn", "nr_arfcn"),
    "earfcn": ("earfcn", "lte_earfcn"),
    "rsrp_dbm": ("rsrp_dbm", "rsrp", "ss_rsrp_dbm", "ss_rsrp"),
    "rsrq_db": ("rsrq_db", "rsrq", "ss_rsrq_db", "ss_rsrq"),
    "sinr_db": ("sinr_db", "sinr", "snr_db", "snr"),
    "rssi_dbm": ("rssi_dbm", "rssi"),
    "lat": ("lat", "latitude"),
    "lon": ("lon", "lng", "long", "longitude"),
    "altitude_m": ("altitude_m", "altitude", "elevation", "alt", "ele"),
    "position_source": ("position_source", "gps_source", "location_source"),
}

RF_SENTINELS = {
    "rsrp_dbm": {-32768.0, -9999.0},
    "rsrq_db": {-32768.0, -9999.0},
    "sinr_db": {-6573.6, -32768.0, -9999.0},
    "rssi_dbm": {-32768.0, -9999.0},
}

_STORE: dict[str, dict[str, Any]] = {}
_STORE_ORDER: list[str] = []
_STORE_LOCK = threading.RLock()


class MeasurementImportError(ValueError):
    pass


def _norm_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")


def _field_map(headers: list[str]) -> dict[str, str]:
    normalized = {_norm_header(h): h for h in headers}
    result: dict[str, str] = {}
    for canonical, aliases in ALIASES.items():
        for alias in aliases:
            if alias in normalized:
                result[canonical] = normalized[alias]
                break
    return result


def _num(value: Any) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null", "na", "n/a", "-"}:
        return None
    try:
        number = float(text.replace(",", "."))
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _timestamp(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        # The exported timestamp_utc field is explicitly UTC, despite having
        # no trailing Z in the CSV format.
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _valid_rf_value(field: str, value: Optional[float]) -> bool:
    if value is None or value in RF_SENTINELS.get(field, set()):
        return False
    # Broad physical plausibility bounds. These are QC bounds, not vendor
    # sensitivity limits or thresholds for the later validation comparison.
    bounds = {
        "rsrp_dbm": (-200.0, 0.0),
        "rsrq_db": (-50.0, 0.0),
        "sinr_db": (-100.0, 100.0),
        "rssi_dbm": (-200.0, 0.0),
    }
    low, high = bounds[field]
    return low <= value <= high


def _stats(values: list[float]) -> Optional[dict[str, float]]:
    if not values:
        return None
    values = sorted(values)

    def q(p: float) -> float:
        if len(values) == 1:
            return values[0]
        pos = (len(values) - 1) * p
        lo = int(math.floor(pos))
        hi = int(math.ceil(pos))
        if lo == hi:
            return values[lo]
        return values[lo] + (values[hi] - values[lo]) * (pos - lo)

    return {
        "count": len(values),
        "mean": float(mean(values)),
        "std": float(pstdev(values)) if len(values) > 1 else 0.0,
        "min": float(values[0]),
        "p05": float(q(0.05)),
        "p25": float(q(0.25)),
        "median": float(q(0.5)),
        "p75": float(q(0.75)),
        "p95": float(q(0.95)),
        "max": float(values[-1]),
    }


def _percentile_position(value: Optional[float], field: str) -> Optional[float]:
    if value is None:
        return None
    if field == "lat":
        return value if -90.0 <= value <= 90.0 else None
    if field == "lon":
        return value if -180.0 <= value <= 180.0 else None
    return value


def _row_quality(row: dict[str, str], fmap: dict[str, str]) -> dict[str, Any]:
    get = lambda key: row.get(fmap.get(key, ""), "") if fmap.get(key) else ""
    values = {key: _num(get(key)) for key in ("rsrp_dbm", "rsrq_db", "sinr_db", "rssi_dbm")}
    lat = _percentile_position(_num(get("lat")), "lat")
    lon = _percentile_position(_num(get("lon")), "lon")
    ts = _timestamp(get("timestamp_utc") or get("timestamp_local"))
    flags: list[str] = []

    for key, value in values.items():
        if not _valid_rf_value(key, value):
            if value in RF_SENTINELS.get(key, set()):
                flags.append(f"sentinel_{key}")
            elif value is None:
                flags.append(f"missing_or_invalid_{key}")
            else:
                flags.append(f"out_of_range_{key}")

    location_valid = lat is not None and lon is not None
    if not location_valid:
        flags.append("missing_or_invalid_gps")
    if ts is None:
        flags.append("missing_or_invalid_timestamp")
    pci = _num(get("pci"))
    if pci is None or not pci.is_integer() or not 0 <= pci <= 1007:
        flags.append("missing_or_invalid_pci")
    arfcn = _num(get("arfcn"))
    rat = str(get("rat") or "").strip()
    radio_valid = _valid_rf_value("rsrp_dbm", values["rsrp_dbm"])
    eligible = radio_valid and location_valid and ts is not None
    return {
        "timestampUtc": ts.isoformat().replace("+00:00", "Z") if ts else None,
        "rat": rat or None,
        "pci": int(pci) if pci is not None and pci.is_integer() and 0 <= pci <= 1007 else None,
        "band": _num(get("band")),
        "arfcn": int(arfcn) if arfcn is not None and arfcn.is_integer() else None,
        "rsrpDbm": values["rsrp_dbm"] if _valid_rf_value("rsrp_dbm", values["rsrp_dbm"]) else None,
        "rsrqDb": values["rsrq_db"] if _valid_rf_value("rsrq_db", values["rsrq_db"]) else None,
        "sinrDb": values["sinr_db"] if _valid_rf_value("sinr_db", values["sinr_db"]) else None,
        "rssiDbm": values["rssi_dbm"] if _valid_rf_value("rssi_dbm", values["rssi_dbm"]) else None,
        "lat": lat,
        "lon": lon,
        "altitudeM": _num(get("altitude_m")),
        "positionSource": str(get("position_source") or "").strip() or None,
        "radioValid": radio_valid,
        "locationValid": location_valid,
        "eligibleForSpatialValidation": eligible,
        "qualityFlags": flags,
    }


def parse_measurement_csv(filename: str, content: bytes | str) -> dict[str, Any]:
    """Parse a Quectel or GPS-joined CSV, preserving original rows and fields."""
    if isinstance(content, bytes):
        if len(content) > MAX_CSV_BYTES:
            raise MeasurementImportError(f"CSV exceeds the {MAX_CSV_BYTES // (1024 * 1024)} MB import limit")
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise MeasurementImportError("CSV must be UTF-8 encoded (UTF-8 BOM is supported)") from exc
    else:
        text = content.lstrip("\ufeff")
        if len(text.encode("utf-8")) > MAX_CSV_BYTES:
            raise MeasurementImportError(f"CSV exceeds the {MAX_CSV_BYTES // (1024 * 1024)} MB import limit")
    if not text.strip():
        raise MeasurementImportError("CSV file is empty")

    lines = [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if not lines:
        raise MeasurementImportError("CSV file has no data rows")
    try:
        delimiter = csv.Sniffer().sniff("\n".join(lines[:20]), delimiters=",;\t").delimiter
    except csv.Error:
        delimiter = ","
    reader = csv.DictReader(io.StringIO("\n".join(lines), newline=""), delimiter=delimiter)
    headers = [h for h in (reader.fieldnames or []) if h is not None]
    if len(headers) < 3:
        raise MeasurementImportError("CSV must contain a header and at least three columns")
    fmap = _field_map(headers)
    if "timestamp_utc" not in fmap:
        raise MeasurementImportError("Could not identify a timestamp column (expected timestamp_utc or timestamp)")
    if "rsrp_dbm" not in fmap:
        raise MeasurementImportError("Could not identify an RSRP column (expected rsrp_dbm or rsrp)")

    original_rows: list[dict[str, str]] = []
    quality_rows: list[dict[str, Any]] = []
    for row in reader:
        if not row or not any((value or "").strip() for value in row.values() if isinstance(value, str)):
            continue
        # Ignore surplus unnamed columns but preserve all named source fields.
        raw = {str(k): (v if v is not None else "") for k, v in row.items() if k is not None}
        original_rows.append(raw)
        quality_rows.append(_row_quality(raw, fmap))
    if not original_rows:
        raise MeasurementImportError("CSV contains no data records")

    timestamps = [r["timestampUtc"] for r in quality_rows if r["timestampUtc"]]
    time_counts = Counter(timestamps)
    duplicate_groups = sum(1 for count in time_counts.values() if count > 1)
    duplicate_extra = sum(count - 1 for count in time_counts.values() if count > 1)

    def vals(field: str, predicate=lambda r: True) -> list[float]:
        return [float(r[field]) for r in quality_rows if predicate(r) and r.get(field) is not None]

    total = len(original_rows)
    radio_valid = sum(bool(r["radioValid"]) for r in quality_rows)
    location_valid = sum(bool(r["locationValid"]) for r in quality_rows)
    eligible = sum(bool(r["eligibleForSpatialValidation"]) for r in quality_rows)
    nr_rows = sum("NR" in (r["rat"] or "").upper() for r in quality_rows)
    lte_rows = sum("LTE" in (r["rat"] or "").upper() for r in quality_rows)
    pcis = Counter(str(r["pci"]) for r in quality_rows if r["pci"] is not None)
    rats = Counter(r["rat"] or "Unknown" for r in quality_rows)
    bands = Counter(str(int(r["band"])) if r["band"] is not None and float(r["band"]).is_integer() else str(r["band"]) for r in quality_rows if r["band"] is not None)
    arfcns = Counter(str(r["arfcn"]) for r in quality_rows if r["arfcn"] is not None)
    position_sources = Counter(r["positionSource"] or "Unspecified" for r in quality_rows)

    latitudes = vals("lat")
    longitudes = vals("lon")
    parsed_times = [_timestamp(t) for t in timestamps]
    parsed_times = sorted(t for t in parsed_times if t)
    deltas = [(b - a).total_seconds() for a, b in zip(parsed_times, parsed_times[1:])]
    delta_stats = _stats([d for d in deltas if d >= 0])

    flag_counts: Counter[str] = Counter()
    for q in quality_rows:
        flag_counts.update(q["qualityFlags"])

    nr_pred = lambda r: "NR" in (r["rat"] or "").upper()
    valid_pred = lambda r: bool(r["radioValid"])
    summary = {
        "filename": filename,
        "totalRows": total,
        "columnCount": len(headers),
        "columns": headers,
        "delimiter": {",": "comma", ";": "semicolon", "\t": "tab"}.get(delimiter, delimiter),
        "timestampStartUtc": min(timestamps) if timestamps else None,
        "timestampEndUtc": max(timestamps) if timestamps else None,
        "durationSeconds": (parsed_times[-1] - parsed_times[0]).total_seconds() if len(parsed_times) >= 2 else None,
        "intervalSeconds": delta_stats,
        "radioValidRows": radio_valid,
        "radioInvalidRows": total - radio_valid,
        "locationValidRows": location_valid,
        "gpsCoveragePercent": round(100.0 * location_valid / total, 3) if total else 0.0,
        "eligibleForSpatialValidationRows": eligible,
        "nrRows": nr_rows,
        "lteRows": lte_rows,
        "otherRatRows": total - nr_rows - lte_rows,
        "uniquePciCount": len(pcis),
        "pciCounts": [{"pci": key, "count": count} for key, count in pcis.most_common()],
        "ratCounts": [{"rat": key, "count": count} for key, count in rats.most_common()],
        "bandCounts": [{"band": key, "count": count} for key, count in bands.most_common()],
        "arfcnCounts": [{"arfcn": key, "count": count} for key, count in arfcns.most_common()],
        "positionSources": [{"source": key, "count": count} for key, count in position_sources.most_common()],
        "duplicateTimestampGroups": duplicate_groups,
        "duplicateTimestampExtraRows": duplicate_extra,
        "latitudeBounds": {"min": min(latitudes), "max": max(latitudes)} if latitudes else None,
        "longitudeBounds": {"min": min(longitudes), "max": max(longitudes)} if longitudes else None,
        "rsrpAllValid": _stats(vals("rsrpDbm", valid_pred)),
        "rsrpNrValid": _stats(vals("rsrpDbm", lambda r: valid_pred(r) and nr_pred(r))),
        "rsrqNrValid": _stats(vals("rsrqDb", lambda r: r["rsrqDb"] is not None and nr_pred(r))),
        "sinrNrValid": _stats(vals("sinrDb", lambda r: r["sinrDb"] is not None and nr_pred(r))),
        "qualityFlagCounts": dict(sorted(flag_counts.items())),
    }
    warnings: list[str] = []
    if location_valid == 0:
        warnings.append("No valid GPS coordinates were found; spatial validation requires a GPS-joined dataset.")
    elif location_valid < total:
        warnings.append(f"{total - location_valid} rows have no valid GPS coordinates.")
    if total - radio_valid:
        warnings.append(f"{total - radio_valid} rows have invalid or missing RSRP and must not enter RF statistics.")
    if duplicate_extra:
        warnings.append(f"{duplicate_extra} extra rows share timestamps; keep them unless a documented deduplication rule is applied.")
    if len(position_sources) == 1 and next(iter(position_sources)).startswith("track:"):
        warnings.append("GPS coordinates are derived from an external track; the original track file is needed to independently audit timestamp matching.")
    summary["warnings"] = warnings

    preview_indices = list(range(min(12, total)))
    preview = []
    for i in preview_indices:
        raw = original_rows[i]
        q = quality_rows[i]
        selected = {key: raw.get(fmap[key], "") for key in fmap if fmap.get(key) in raw}
        preview.append({**selected, **{
            "radioValid": q["radioValid"],
            "locationValid": q["locationValid"],
            "eligibleForSpatialValidation": q["eligibleForSpatialValidation"],
            "qualityFlags": q["qualityFlags"],
        }})

    return {
        "datasetId": uuid.uuid4().hex,
        "filename": filename,
        "columns": headers,
        "fieldMap": fmap,
        "rows": original_rows,
        "qualityRows": quality_rows,
        "summary": summary,
        "preview": preview,
    }


def store_measurement_dataset(dataset: dict[str, Any]) -> None:
    dataset_id = dataset["datasetId"]
    with _STORE_LOCK:
        _STORE[dataset_id] = dataset
        if dataset_id in _STORE_ORDER:
            _STORE_ORDER.remove(dataset_id)
        _STORE_ORDER.append(dataset_id)
        while len(_STORE_ORDER) > MAX_DATASETS:
            old = _STORE_ORDER.pop(0)
            _STORE.pop(old, None)


def get_measurement_dataset(dataset_id: str) -> Optional[dict[str, Any]]:
    with _STORE_LOCK:
        return _STORE.get(dataset_id)


def list_measurement_datasets() -> list[dict[str, Any]]:
    with _STORE_LOCK:
        return [
            {
                "datasetId": dataset_id,
                "filename": _STORE[dataset_id]["filename"],
                "totalRows": _STORE[dataset_id]["summary"]["totalRows"],
                "radioValidRows": _STORE[dataset_id]["summary"]["radioValidRows"],
                "locationValidRows": _STORE[dataset_id]["summary"]["locationValidRows"],
            }
            for dataset_id in reversed(_STORE_ORDER)
            if dataset_id in _STORE
        ]


def get_measurement_rows(
    dataset_id: str,
    *,
    rat: Optional[str] = None,
    pci: Optional[int] = None,
    valid_only: bool = False,
    spatial_only: bool = False,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    dataset = get_measurement_dataset(dataset_id)
    if dataset is None:
        raise KeyError(dataset_id)
    result = []
    for index, (raw, quality) in enumerate(zip(dataset["rows"], dataset["qualityRows"])):
        if rat and (quality["rat"] or "").upper() != rat.upper():
            continue
        if pci is not None and quality["pci"] != pci:
            continue
        if valid_only and not quality["radioValid"]:
            continue
        if spatial_only and not quality["eligibleForSpatialValidation"]:
            continue
        result.append({"rowIndex": index, "raw": raw, "quality": quality})
    total = len(result)
    return {"total": total, "offset": offset, "limit": limit, "rows": result[offset:offset + limit]}


def export_measurement_csv(dataset_id: str, *, spatial_only: bool = False) -> str:
    dataset = get_measurement_dataset(dataset_id)
    if dataset is None:
        raise KeyError(dataset_id)
    output = io.StringIO(newline="")
    columns = list(dataset["columns"]) + [
        "validation_radio_valid", "validation_location_valid",
        "validation_eligible_for_spatial_validation", "validation_quality_flags",
    ]
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for raw, quality in zip(dataset["rows"], dataset["qualityRows"]):
        if spatial_only and not quality["eligibleForSpatialValidation"]:
            continue
        row = dict(raw)
        row.update({
            "validation_radio_valid": int(quality["radioValid"]),
            "validation_location_valid": int(quality["locationValid"]),
            "validation_eligible_for_spatial_validation": int(quality["eligibleForSpatialValidation"]),
            "validation_quality_flags": ";".join(quality["qualityFlags"]),
        })
        writer.writerow(row)
    return output.getvalue()


def clear_measurement_store() -> None:
    with _STORE_LOCK:
        _STORE.clear()
        _STORE_ORDER.clear()


# WGS84 local tangent-plane transform deliberately mirrors src/utils.ts.
# This keeps measurement ENU coordinates consistent with the active Studio
# scene; it is intended for campus-scale scenes, not regional-scale mapping.
_WGS84_A = 6378137.0
_WGS84_F = 1.0 / 298.257223563
_WGS84_E2 = _WGS84_F * (2.0 - _WGS84_F)


def wgs84_to_scene_enu(latitude: float, longitude: float, anchor_latitude: float, anchor_longitude: float) -> tuple[float, float]:
    if not (-90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
        raise ValueError("Invalid WGS84 latitude/longitude")
    if not (-90.0 <= anchor_latitude <= 90.0 and -180.0 <= anchor_longitude <= 180.0):
        raise ValueError("Invalid scene anchor latitude/longitude")
    lat_rad = math.radians(anchor_latitude)
    sin_lat = math.sin(lat_rad)
    denominator = math.sqrt(1.0 - _WGS84_E2 * sin_lat * sin_lat)
    prime_vertical = _WGS84_A / denominator
    meridional = _WGS84_A * (1.0 - _WGS84_E2) / (denominator ** 3)
    east = math.radians(longitude - anchor_longitude) * prime_vertical * math.cos(lat_rad)
    north = math.radians(latitude - anchor_latitude) * meridional
    return east, north


def _utm34n_transformer():
    try:
        from pyproj import Transformer
    except ImportError as exc:  # pragma: no cover - exercised in minimal installations
        raise RuntimeError("pyproj is required for EPSG:32634 audit/export; install backend requirements") from exc
    return Transformer.from_crs("EPSG:4326", "EPSG:32634", always_xy=True)


def _range_stats(values: list[float]) -> Optional[dict[str, float]]:
    return _stats(values) if values else None


def compute_geospatial_audit(
    dataset_id: str,
    *,
    anchor_latitude: float,
    anchor_longitude: float,
    scene_bounds: Optional[dict[str, float]] = None,
) -> dict[str, Any]:
    """Transform GPS-joined measurements into scene ENU and UTM 34N diagnostics.

    `scene_bounds` is the rectangular envelope of the active scene geometry,
    expressed in the Studio's local ENU metres. It is not an exact geometry mask.
    GPS altitude is reported but never converted into scene Z because its
    vertical datum and the scene's vertical datum have not been established.
    """
    dataset = get_measurement_dataset(dataset_id)
    if dataset is None:
        raise KeyError(dataset_id)
    if not (-90.0 <= anchor_latitude <= 90.0 and -180.0 <= anchor_longitude <= 180.0):
        raise ValueError("Scene anchor must be valid WGS84 latitude/longitude")

    bounds = None
    if scene_bounds is not None:
        required = ("xMin", "xMax", "yMin", "yMax")
        if not all(key in scene_bounds and math.isfinite(float(scene_bounds[key])) for key in required):
            raise ValueError("Scene bounds must contain finite xMin, xMax, yMin, and yMax")
        bounds = {key: float(scene_bounds[key]) for key in required}
        if bounds["xMin"] > bounds["xMax"] or bounds["yMin"] > bounds["yMax"]:
            raise ValueError("Scene bounds minimum must not exceed maximum")

    transformer = _utm34n_transformer()
    coordinates: list[dict[str, Any]] = []
    east_values: list[float] = []
    north_values: list[float] = []
    utm_east_values: list[float] = []
    utm_north_values: list[float] = []
    distances: list[float] = []
    altitudes: list[float] = []
    within_count = 0
    outside_count = 0
    within_eligible = 0
    outside_eligible = 0
    utm_zone_applicable = True

    for index, quality in enumerate(dataset["qualityRows"]):
        lat, lon = quality.get("lat"), quality.get("lon")
        if lat is None or lon is None:
            coordinates.append({"rowIndex": index, "east": None, "north": None, "utmE": None, "utmN": None, "within": None})
            continue
        east, north = wgs84_to_scene_enu(float(lat), float(lon), anchor_latitude, anchor_longitude)
        # UTM zone 34N has a nominal longitude span of 18E–24E and latitude
        # validity 0–84N. Keep the conversion but flag any point outside it.
        zone_ok = 0.0 <= float(lat) <= 84.0 and 18.0 <= float(lon) < 24.0
        if not zone_ok:
            utm_zone_applicable = False
        utm_e, utm_n = transformer.transform(float(lon), float(lat))
        within = None
        if bounds is not None:
            within = bounds["xMin"] <= east <= bounds["xMax"] and bounds["yMin"] <= north <= bounds["yMax"]
            if within:
                within_count += 1
                if quality.get("eligibleForSpatialValidation"):
                    within_eligible += 1
            else:
                outside_count += 1
                if quality.get("eligibleForSpatialValidation"):
                    outside_eligible += 1
        east_values.append(east)
        north_values.append(north)
        utm_east_values.append(float(utm_e))
        utm_north_values.append(float(utm_n))
        distances.append(math.hypot(east, north))
        altitude = quality.get("altitudeM")
        if altitude is not None and math.isfinite(float(altitude)):
            altitudes.append(float(altitude))
        coordinates.append({
            "rowIndex": index,
            "east": east,
            "north": north,
            "utmE": float(utm_e),
            "utmN": float(utm_n),
            "within": within,
        })

    location_count = len(east_values)
    eligible_count = int(dataset["summary"]["eligibleForSpatialValidationRows"])
    mean_east = sum(east_values) / location_count if location_count else None
    mean_north = sum(north_values) / location_count if location_count else None
    anchor_distance = math.hypot(mean_east, mean_north) if mean_east is not None and mean_north is not None else None
    anchor_inside = None
    if bounds is not None:
        anchor_inside = bounds["xMin"] <= 0.0 <= bounds["xMax"] and bounds["yMin"] <= 0.0 <= bounds["yMax"]

    warnings: list[str] = []
    if location_count == 0:
        warnings.append("Dataset has no valid GPS coordinates; import the GPS-joined CSV before spatial alignment.")
    if bounds is None:
        warnings.append("Active scene geometry bounds are unavailable; inside/outside-scene counts cannot be computed.")
    if anchor_distance is not None and anchor_distance > 2500.0:
        warnings.append("The GPS-track centroid is more than 2.5 km from the active scene anchor. Verify that the scene anchor belongs to the measured campus area.")
    if anchor_inside is False:
        warnings.append("The scene anchor (ENU origin) is outside the active geometry envelope. Verify scene anchor and imported OSM geometry alignment.")
    if not utm_zone_applicable:
        warnings.append("One or more GPS points are outside the nominal EPSG:32634 UTM zone 34N area; check the selected projected CRS.")
    sources = dataset["summary"].get("positionSources", [])
    if any(str(x.get("source", "")).startswith("track:") for x in sources):
        warnings.append("Coordinates originate from an external GPS track, but the original track file is unavailable; timestamp offset/interpolation cannot be independently reproduced.")
    warnings.append("GPS altitude is retained as source metadata only. Scene Z is not assigned because the GPS and 3D scene vertical datums are not verified.")
    warnings.append("Inside-scene classification uses the rectangular ENU envelope of active scene geometry, not a point-in-mesh or road-surface test.")

    return {
        "datasetId": dataset_id,
        "filename": dataset["filename"],
        "sourceCrs": "EPSG:4326 (assumed from GPS latitude/longitude fields; original track metadata unavailable)",
        "sceneCoordinateSystem": "WGS84_LOCAL_TANGENT_ENU",
        "metricProjectedCrs": "EPSG:32634",
        "metricProjectedCrsApplicable": utm_zone_applicable,
        "anchor": {"latitude": float(anchor_latitude), "longitude": float(anchor_longitude)},
        "sceneBounds": bounds,
        "sceneBoundsMeaning": "Rectangular envelope of active scene geometry ENU vertices; not an exact scene/road mask.",
        "totalRows": len(dataset["rows"]),
        "locationRows": location_count,
        "eligibleForSpatialValidationRows": eligible_count,
        "withinSceneEnvelopeRows": within_count if bounds is not None else None,
        "outsideSceneEnvelopeRows": outside_count if bounds is not None else None,
        "withinSceneEnvelopeEligibleRows": within_eligible if bounds is not None else None,
        "outsideSceneEnvelopeEligibleRows": outside_eligible if bounds is not None else None,
        "anchorInsideSceneEnvelope": anchor_inside,
        "gpsCentroidEnu": {"eastM": mean_east, "northM": mean_north},
        "gpsCentroidDistanceFromAnchorM": anchor_distance,
        "sceneEnuBoundsOfMeasurements": {
            "eastMinM": min(east_values), "eastMaxM": max(east_values),
            "northMinM": min(north_values), "northMaxM": max(north_values),
        } if location_count else None,
        "utm34nBounds": {
            "eastingMinM": min(utm_east_values), "eastingMaxM": max(utm_east_values),
            "northingMinM": min(utm_north_values), "northingMaxM": max(utm_north_values),
        } if location_count else None,
        "anchorDistanceStatsM": _range_stats(distances),
        "gpsAltitudeStatsM": _range_stats(altitudes),
        "distinctGpsPositions": len({(round(float(q["lat"]), 7), round(float(q["lon"]), 7)) for q in dataset["qualityRows"] if q.get("lat") is not None and q.get("lon") is not None}),
        "warnings": warnings,
        "preview": [
            {
                "rowIndex": item["rowIndex"],
                "latitude": dataset["qualityRows"][item["rowIndex"]].get("lat"),
                "longitude": dataset["qualityRows"][item["rowIndex"]].get("lon"),
                "eastM": item["east"], "northM": item["north"],
                "utmEastingM": item["utmE"], "utmNorthingM": item["utmN"],
                "withinSceneEnvelope": item["within"],
            }
            for item in coordinates if item["east"] is not None
        ][:10],
        "_coordinateRows": coordinates,
    }


def export_georeferenced_measurement_csv(
    dataset_id: str,
    *,
    anchor_latitude: float,
    anchor_longitude: float,
    scene_bounds: Optional[dict[str, float]] = None,
) -> str:
    """Export every original row plus WGS84→scene ENU and UTM 34N coordinates."""
    dataset = get_measurement_dataset(dataset_id)
    if dataset is None:
        raise KeyError(dataset_id)
    audit = compute_geospatial_audit(
        dataset_id, anchor_latitude=anchor_latitude,
        anchor_longitude=anchor_longitude, scene_bounds=scene_bounds,
    )
    derived_by_index = {row["rowIndex"]: row for row in audit["_coordinateRows"]}
    output = io.StringIO(newline="")
    extra_columns = [
        "georef_source_crs_assumption", "georef_scene_crs", "georef_utm_crs",
        "georef_anchor_latitude", "georef_anchor_longitude",
        "scene_x_east_m", "scene_y_north_m", "scene_z_up_m",
        "utm34n_easting_m", "utm34n_northing_m", "within_scene_envelope",
        "georef_z_status",
    ]
    writer = csv.DictWriter(output, fieldnames=list(dataset["columns"]) + extra_columns, extrasaction="ignore")
    writer.writeheader()
    for index, (raw, quality) in enumerate(zip(dataset["rows"], dataset["qualityRows"])):
        derived = derived_by_index[index]
        row = dict(raw)
        row.update({
            "georef_source_crs_assumption": "EPSG:4326",
            "georef_scene_crs": "WGS84_LOCAL_TANGENT_ENU",
            "georef_utm_crs": "EPSG:32634",
            "georef_anchor_latitude": anchor_latitude,
            "georef_anchor_longitude": anchor_longitude,
            "scene_x_east_m": derived["east"] if derived["east"] is not None else "",
            "scene_y_north_m": derived["north"] if derived["north"] is not None else "",
            # Deliberately blank: GPS altitude datum vs scene vertical datum is unknown.
            "scene_z_up_m": "",
            "utm34n_easting_m": derived["utmE"] if derived["utmE"] is not None else "",
            "utm34n_northing_m": derived["utmN"] if derived["utmN"] is not None else "",
            "within_scene_envelope": "" if derived["within"] is None else int(bool(derived["within"])),
            "georef_z_status": "UNVERIFIED_VERTICAL_DATUM",
        })
        writer.writerow(row)
    return output.getvalue()
