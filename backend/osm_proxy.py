"""Server-side proxy for public Overpass instances.

The browser talks to this app's same-origin /api/osm/query endpoint instead of
calling third-party Overpass hosts directly. This avoids relying on provider
CORS configuration, gives requests an identifiable User-Agent, and centralizes
provider failover / rate limiting in the Colab backend.

The proxy intentionally accepts only a bounding box, never an arbitrary URL or
OverpassQL string, so it cannot be used as an open HTTP proxy.
"""
from __future__ import annotations

import json
import math
import socket
import threading
import time
from collections import OrderedDict
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

# Ordered by the published global-instance directory and current observed
# reliability. maps.mail.ru is a global-data instance; private.coffee and the
# FOSSGIS instance remain independent fallbacks.
OVERPASS_ENDPOINTS: tuple[str, ...] = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)

OSM_QUERY_TIMEOUT_SECONDS = 45
OSM_HTTP_TIMEOUT_SECONDS = 55
OSM_REQUEST_START_INTERVAL_SECONDS = 1.5
OSM_MAX_TILE_SIDE_METERS = 3_000
OSM_TILE_CACHE_TTL_SECONDS = 30 * 60
OSM_TILE_CACHE_MAX_BYTES = 64 * 1024 * 1024
OSM_USER_AGENT = (
    "SionnaRTStudio/1.0 (OpenStreetMap data fetch; "
    "https://github.com/puloktarafder/SionnaRTStudio)"
)

_request_lock = threading.Lock()
_next_request_at = 0.0
_preferred_endpoint_index = 0
_cache_lock = threading.Lock()
_tile_cache: OrderedDict[tuple[str, str, str, str], tuple[float, int, dict[str, Any]]] = OrderedDict()
_tile_cache_bytes = 0


class OSMProxyError(Exception):
    """A typed upstream failure safe to return to the frontend."""

    def __init__(
        self,
        message: str,
        kind: str,
        status_code: int,
        retry_after_seconds: int = 0,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.status_code = status_code
        self.retry_after_seconds = max(0, int(retry_after_seconds))


def _format_coordinate(value: float) -> str:
    return f"{value:.7f}".rstrip("0").rstrip(".") or "0"


def validate_bounds(south: float, west: float, north: float, east: float) -> None:
    values = (south, west, north, east)
    if not all(isinstance(value, (int, float)) and value == value and abs(value) != float("inf") for value in values):
        raise ValueError("OSM selection contains a non-finite coordinate.")
    if south < -90 or north > 90 or south >= north:
        raise ValueError("Invalid OSM latitude bounds. Expected -90 ≤ south < north ≤ 90.")
    if west < -180 or east > 180 or west >= east:
        raise ValueError("Invalid OSM longitude bounds. Date-line-crossing selections are not supported.")

    mean_latitude = (south + north) / 2
    height_m = (north - south) * 110_574
    width_m = (east - west) * 111_320 * max(abs(math.cos(math.radians(mean_latitude))), 1e-4)
    if max(height_m, width_m) > OSM_MAX_TILE_SIDE_METERS:
        raise ValueError(
            f"OSM proxy accepts one tile up to {OSM_MAX_TILE_SIDE_METERS} m per side; "
            "the frontend must split larger user selections into smaller tiles."
        )


def build_overpass_query(
    south: float,
    west: float,
    north: float,
    east: float,
) -> str:
    """Build the production OSM query; physical feature scope stays unchanged."""
    validate_bounds(south, west, north, east)
    bbox = ",".join(_format_coordinate(v) for v in (south, west, north, east))
    return f"""[out:json][timeout:{OSM_QUERY_TIMEOUT_SECONDS}];
(
  way[\"building\"]({bbox});
  relation[\"building\"]({bbox});
  way[\"highway\"]({bbox});
  way[\"leisure\"=\"park\"]({bbox});
  way[\"landuse\"~\"grass|forest|meadow|orchard\"]({bbox});
  way[\"natural\"~\"wood|scrub|water\"]({bbox});
);
out body;
>;
out skel qt;"""


def _retry_after_seconds(headers: Any) -> int:
    value = headers.get("Retry-After") if headers is not None else None
    if value is None:
        return 0
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        # Retry-After may also be an HTTP-date, not only a number of seconds.
        try:
            retry_at = parsedate_to_datetime(str(value))
            return max(0, int(retry_at.timestamp() - time.time()))
        except (TypeError, ValueError, OverflowError):
            return 0


def _classify_http_error(status: int, body: str) -> tuple[str, int]:
    lowered = body.lower()
    if status in (429, 406):
        return "rate-limit", 429
    if (
        status == 413
        or "out of memory" in lowered
        or "memory exhausted" in lowered
        or "query timed out" in lowered
        or "runtime error: query" in lowered
    ):
        return "query-resource", 422
    if status in (502, 503, 504):
        # A gateway/capacity rejection is a provider availability issue. Do not
        # fan it out into four more public requests by subdividing the same box.
        return "capacity", 503
    if status == 400:
        return "fatal", 400
    return "network", 502


def _post_to_endpoint(endpoint: str, query: str) -> dict[str, Any]:
    payload = urlencode({"data": query}).encode("utf-8")
    request = Request(
        endpoint,
        data=payload,
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "application/json",
            "User-Agent": OSM_USER_AGENT,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=OSM_HTTP_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        raw = exc.read(2_000).decode("utf-8", errors="replace")
        compact = " ".join(raw.split())[:420]
        kind, status_code = _classify_http_error(exc.code, raw)
        retry_after = _retry_after_seconds(exc.headers)
        raise OSMProxyError(
            f"HTTP {exc.code} from {urlparse(endpoint).netloc}"
            + (f": {compact}" if compact else ""),
            kind,
            status_code,
            retry_after,
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise OSMProxyError(
            f"request timed out after {OSM_HTTP_TIMEOUT_SECONDS}s at {urlparse(endpoint).netloc}",
            "capacity",
            503,
        ) from exc
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        kind = "capacity" if isinstance(reason, (TimeoutError, socket.timeout)) else "network"
        raise OSMProxyError(
            f"network error at {urlparse(endpoint).netloc}: {reason}",
            kind,
            503 if kind == "capacity" else 502,
        ) from exc
    except OSError as exc:
        raise OSMProxyError(
            f"connection error at {urlparse(endpoint).netloc}: {exc}",
            "network",
            502,
        ) from exc

    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        compact = " ".join(body.split())[:220]
        raise OSMProxyError(
            f"non-JSON response from {urlparse(endpoint).netloc}: {compact}",
            "network",
            502,
        ) from exc

    if not isinstance(data, dict):
        raise OSMProxyError(
            f"invalid JSON response from {urlparse(endpoint).netloc}",
            "network",
            502,
        )

    remark = data.get("remark")
    if remark:
        compact = " ".join(str(remark).split())[:420]
        lowered = compact.lower()
        is_resource_error = any(
            token in lowered
            for token in ("timed out", "timeout", "out of memory", "memory exhausted", "query run out of memory")
        )
        raise OSMProxyError(
            f"Overpass query remark from {urlparse(endpoint).netloc}: {compact}",
            "query-resource" if is_resource_error else "network",
            422 if is_resource_error else 502,
        )

    if not isinstance(data.get("elements"), list):
        raise OSMProxyError(
            f"response from {urlparse(endpoint).netloc} has no elements array",
            "network",
            502,
        )

    data["source"] = urlparse(endpoint).netloc
    return data


def _tile_cache_key(south: float, west: float, north: float, east: float) -> tuple[str, str, str, str]:
    return tuple(_format_coordinate(value) for value in (south, west, north, east))  # type: ignore[return-value]


def _read_cached_tile(key: tuple[str, str, str, str]) -> dict[str, Any] | None:
    now = time.time()
    with _cache_lock:
        cached = _tile_cache.get(key)
        if cached is None:
            return None
        fetched_at, _size, payload = cached
        if now - fetched_at > OSM_TILE_CACHE_TTL_SECONDS:
            global _tile_cache_bytes
            _tile_cache_bytes -= _size
            del _tile_cache[key]
            return None
        _tile_cache.move_to_end(key)
        # The cached structure is read-only by convention after insertion.
        return payload


def _cache_tile(key: tuple[str, str, str, str], payload: dict[str, Any]) -> None:
    global _tile_cache_bytes
    encoded_size = len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    if encoded_size > OSM_TILE_CACHE_MAX_BYTES // 2:
        return
    now = time.time()
    with _cache_lock:
        old = _tile_cache.pop(key, None)
        if old:
            _tile_cache_bytes -= old[1]
        while _tile_cache and _tile_cache_bytes + encoded_size > OSM_TILE_CACHE_MAX_BYTES:
            _old_key, (_time, old_size, _payload) = _tile_cache.popitem(last=False)
            _tile_cache_bytes -= old_size
        _tile_cache[key] = (now, encoded_size, payload)
        _tile_cache_bytes += encoded_size


def clear_tile_cache() -> None:
    """Clear the in-memory tile cache (also useful for deterministic tests)."""
    global _tile_cache_bytes
    with _cache_lock:
        _tile_cache.clear()
        _tile_cache_bytes = 0


def fetch_osm_tile(south: float, west: float, north: float, east: float) -> dict[str, Any]:
    """Fetch one tile, trying the global instances sequentially.

    All outbound OSM requests are serialized per backend process and spaced to
    avoid parallel bursts against shared public infrastructure.
    """
    global _next_request_at, _preferred_endpoint_index
    query = build_overpass_query(south, west, north, east)
    cache_key = _tile_cache_key(south, west, north, east)
    cached = _read_cached_tile(cache_key)
    if cached is not None:
        return cached
    endpoints = list(OVERPASS_ENDPOINTS)
    if not endpoints:
        raise OSMProxyError("No Overpass endpoints are configured.", "fatal", 503)

    start = _preferred_endpoint_index % len(endpoints)
    ordered = endpoints[start:] + endpoints[:start]
    errors: list[OSMProxyError] = []

    for endpoint in ordered:
        try:
            with _request_lock:
                now = time.monotonic()
                wait_seconds = max(0.0, _next_request_at - now)
                if wait_seconds:
                    time.sleep(wait_seconds)
                _next_request_at = time.monotonic() + OSM_REQUEST_START_INTERVAL_SECONDS
                data = _post_to_endpoint(endpoint, query)
            _preferred_endpoint_index = endpoints.index(endpoint)
            _cache_tile(cache_key, data)
            return data
        except OSMProxyError as exc:
            errors.append(exc)
            # A syntax error applies to every mirror: retrying the same query is
            # pointless and adds load, so fail immediately.
            if exc.kind == "fatal":
                raise

    details = " | ".join(str(error) for error in errors)
    kinds = [error.kind for error in errors]
    retry_after = max((error.retry_after_seconds for error in errors), default=0)

    if kinds and all(kind == "query-resource" for kind in kinds):
        kind, status_code = "query-resource", 422
    elif "rate-limit" in kinds and all(kind in ("rate-limit", "network") for kind in kinds):
        kind, status_code = "rate-limit", 429
    elif "capacity" in kinds:
        kind, status_code = "capacity", 503
    else:
        kind, status_code = "network", 502

    raise OSMProxyError(
        f"All Overpass instances failed for this tile. {details}",
        kind,
        status_code,
        retry_after,
    )
