from __future__ import annotations

import io
import json
import unittest
from datetime import datetime, timedelta, timezone
from email.message import Message
from email.utils import format_datetime
from unittest.mock import patch

from backend import osm_proxy
from backend.osm_proxy import OSMProxyError


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


class OSMProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        osm_proxy._preferred_endpoint_index = 0
        osm_proxy._next_request_at = 0.0
        osm_proxy.clear_tile_cache()
        self.bounds = (45.24, 19.79, 45.26, 19.81)

    def test_maps_mail_is_first_provider_and_success_is_tagged(self) -> None:
        payload = {"elements": [{"type": "node", "id": 1}], "source": "maps.mail.ru"}
        with patch.object(osm_proxy, "_post_to_endpoint", return_value=payload) as post:
            result = osm_proxy.fetch_osm_tile(*self.bounds)
        self.assertEqual(post.call_args.args[0], osm_proxy.OVERPASS_ENDPOINTS[0])
        self.assertEqual(result["source"], "maps.mail.ru")
        self.assertEqual(len(result["elements"]), 1)

    def test_falls_back_after_capacity_response(self) -> None:
        payload = {"elements": [], "source": "overpass.private.coffee"}
        with (
            patch.object(
                osm_proxy,
                "_post_to_endpoint",
                side_effect=[
                    OSMProxyError("HTTP 502: server at capacity", "capacity", 503),
                    payload,
                ],
            ) as post,
            patch.object(osm_proxy.time, "sleep", return_value=None),
        ):
            result = osm_proxy.fetch_osm_tile(*self.bounds)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args_list[0].args[0], osm_proxy.OVERPASS_ENDPOINTS[0])
        self.assertEqual(post.call_args_list[1].args[0], osm_proxy.OVERPASS_ENDPOINTS[1])
        self.assertEqual(result["source"], "overpass.private.coffee")

    def test_all_provider_capacity_failures_are_not_query_resource_errors(self) -> None:
        errors = [OSMProxyError(f"busy {i}", "capacity", 503) for i in range(3)]
        with (
            patch.object(osm_proxy, "_post_to_endpoint", side_effect=errors),
            patch.object(osm_proxy.time, "sleep", return_value=None),
        ):
            with self.assertRaises(OSMProxyError) as caught:
                osm_proxy.fetch_osm_tile(*self.bounds)
        self.assertEqual(caught.exception.kind, "capacity")
        self.assertEqual(caught.exception.status_code, 503)

    def test_only_explicit_resource_failure_from_every_provider_is_subdividable(self) -> None:
        errors = [OSMProxyError(f"query timed out {i}", "query-resource", 422) for i in range(3)]
        with (
            patch.object(osm_proxy, "_post_to_endpoint", side_effect=errors),
            patch.object(osm_proxy.time, "sleep", return_value=None),
        ):
            with self.assertRaises(OSMProxyError) as caught:
                osm_proxy.fetch_osm_tile(*self.bounds)
        self.assertEqual(caught.exception.kind, "query-resource")
        self.assertEqual(caught.exception.status_code, 422)

    def test_mixed_capacity_and_resource_failures_do_not_force_subdivision(self) -> None:
        errors = [
            OSMProxyError("query timed out", "query-resource", 422),
            OSMProxyError("gateway overloaded", "capacity", 503),
            OSMProxyError("connection reset", "network", 502),
        ]
        with (
            patch.object(osm_proxy, "_post_to_endpoint", side_effect=errors),
            patch.object(osm_proxy.time, "sleep", return_value=None),
        ):
            with self.assertRaises(OSMProxyError) as caught:
                osm_proxy.fetch_osm_tile(*self.bounds)
        self.assertEqual(caught.exception.kind, "capacity")

    def test_http_200_overpass_remark_is_not_accepted_as_data(self) -> None:
        body = json.dumps({"elements": [], "remark": "runtime error: Query timed out"}).encode()
        fake = _FakeResponse(body)
        with patch.object(osm_proxy, "urlopen", return_value=fake):
            with self.assertRaises(OSMProxyError) as caught:
                osm_proxy._post_to_endpoint(osm_proxy.OVERPASS_ENDPOINTS[0], "[out:json];out;")
        self.assertEqual(caught.exception.kind, "query-resource")

    def test_request_has_identifiable_user_agent_and_form_body(self) -> None:
        captured = {}
        fake = _FakeResponse(b'{"elements":[]}')

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return fake

        with patch.object(osm_proxy, "urlopen", side_effect=fake_urlopen):
            result = osm_proxy._post_to_endpoint(
                osm_proxy.OVERPASS_ENDPOINTS[0],
                osm_proxy.build_overpass_query(*self.bounds),
            )
        request = captured["request"]
        self.assertIn("SionnaRTStudio", request.get_header("User-agent"))
        self.assertIn("application/x-www-form-urlencoded", request.get_header("Content-type"))
        self.assertEqual(captured["timeout"], osm_proxy.OSM_HTTP_TIMEOUT_SECONDS)
        self.assertIn("elements", result)

    def test_retry_after_supports_http_date_format(self) -> None:
        retry_at = datetime.now(timezone.utc) + timedelta(seconds=45)
        headers = Message()
        headers["Retry-After"] = format_datetime(retry_at, usegmt=True)
        seconds = osm_proxy._retry_after_seconds(headers)
        self.assertGreaterEqual(seconds, 43)
        self.assertLessEqual(seconds, 45)

    def test_http_502_capacity_is_not_misclassified_as_query_size(self) -> None:
        kind, status = osm_proxy._classify_http_error(
            502,
            "This Overpass API server is currently at capacity. All query workers are busy and the request queue is full.",
        )
        self.assertEqual(kind, "capacity")
        self.assertEqual(status, 503)

    def test_http_504_with_explicit_query_timeout_is_subdivision_candidate(self) -> None:
        kind, status = osm_proxy._classify_http_error(504, "runtime error: Query timed out")
        self.assertEqual(kind, "query-resource")
        self.assertEqual(status, 422)

    def test_identical_tile_is_cached_without_a_second_upstream_call(self) -> None:
        payload = {"elements": [{"type": "node", "id": 99}], "source": "maps.mail.ru"}
        with patch.object(osm_proxy, "_post_to_endpoint", return_value=payload) as post:
            first = osm_proxy.fetch_osm_tile(*self.bounds)
            second = osm_proxy.fetch_osm_tile(*self.bounds)
        self.assertEqual(first, second)
        self.assertEqual(post.call_count, 1)

    def test_proxy_rejects_oversized_single_tile(self) -> None:
        with patch.object(osm_proxy, "_post_to_endpoint") as post:
            with self.assertRaisesRegex(ValueError, "must split larger user selections"):
                osm_proxy.fetch_osm_tile(45.0, 19.0, 45.1, 19.1)
        post.assert_not_called()

    def test_invalid_bounds_are_rejected_before_network(self) -> None:
        with patch.object(osm_proxy, "_post_to_endpoint") as post:
            with self.assertRaises(ValueError):
                osm_proxy.fetch_osm_tile(46, 20, 45, 21)
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
