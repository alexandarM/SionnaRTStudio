"""Tests for the universal source-scene coordinate adapter (no Sionna/GPU)."""
from __future__ import annotations

import itertools
import math
import unittest

from pydantic import ValidationError

from backend.scene_coordinates import (
    CANONICAL_FRAME,
    SceneBounds,
    SceneCoordinateFrame,
    SceneCoordinatePreviewRequest,
    SceneCoordinateTransform,
    axis_vector,
    determinant3,
    preview_coordinate_transform,
)


class SceneCoordinateFrameTests(unittest.TestCase):
    def test_canonical_frame_is_identity(self):
        frame = SceneCoordinateFrame(upAxis="+Z", forwardAxis="+X", units="m", handedness="right")
        transform = SceneCoordinateTransform(frame)
        point = (1.25, -2.5, 3.75)
        self.assertEqual(transform.point_to_canonical(point), point)
        self.assertEqual(transform.point_from_canonical(point), point)
        self.assertEqual(transform.matrix, ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)))
        self.assertAlmostEqual(transform.determinant, 1.0)
        self.assertFalse(transform.requires_winding_flip)

    def test_current_classroom_y_up_profile_maps_to_z_up(self):
        # This describes the user's current classroom only; it is not a default.
        frame = SceneCoordinateFrame(upAxis="+Y", forwardAxis="+Z", units="m", handedness="right")
        transform = SceneCoordinateTransform(frame)
        self.assertEqual(transform.point_to_canonical((2.0, 1.2, 3.0)), (3.0, 2.0, 1.2))
        self.assertEqual(transform.vector_to_canonical((0.0, 1.0, 0.0)), (0.0, 0.0, 1.0))
        self.assertEqual(transform.vector_to_canonical((0.0, 0.0, 1.0)), (1.0, 0.0, 0.0))
        self.assertAlmostEqual(transform.determinant, 1.0)

    def test_all_24_orthogonal_signed_axis_pairs_are_supported(self):
        axes = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]
        valid_pairs = 0
        for up, forward in itertools.product(axes, repeat=2):
            try:
                frame = SceneCoordinateFrame(upAxis=up, forwardAxis=forward, units="m", handedness="right")
            except ValidationError:
                continue
            transform = SceneCoordinateTransform(frame)
            self.assertAlmostEqual(abs(transform.determinant), 1.0)
            valid_pairs += 1
        self.assertEqual(valid_pairs, 24)

    def test_source_profile_does_not_silently_assume_axes_or_units(self):
        with self.assertRaises(ValidationError):
            SceneCoordinateFrame()  # type: ignore[call-arg]

    def test_rejects_parallel_or_opposite_up_and_forward(self):
        for up, forward in (("+Y", "+Y"), ("+Y", "-Y"), ("-Z", "+Z")):
            with self.subTest(up=up, forward=forward):
                with self.assertRaises(ValidationError):
                    SceneCoordinateFrame(upAxis=up, forwardAxis=forward, units="m", handedness="right")

    def test_units_convert_to_meters(self):
        expected = {"m": 2.0, "cm": 0.02, "mm": 0.002, "ft": 0.6096, "in": 0.0508}
        for unit, value in expected.items():
            with self.subTest(unit=unit):
                transform = SceneCoordinateTransform(SceneCoordinateFrame(upAxis="+Z", forwardAxis="+X", units=unit, handedness="right"))
                self.assertAlmostEqual(transform.point_to_canonical((2, 0, 0))[0], value)

    def test_custom_scene_unit_scale_is_supported(self):
        frame = SceneCoordinateFrame(
            upAxis="+Z", forwardAxis="+X", units="custom", handedness="right",
            customScaleToMeters=0.0025,
        )
        transform = SceneCoordinateTransform(frame)
        self.assertAlmostEqual(transform.point_to_canonical((4, 0, 0))[0], 0.01)
        with self.assertRaises(ValidationError):
            SceneCoordinateFrame(
                upAxis="+Z", forwardAxis="+X", units="custom", handedness="right"
            )
        with self.assertRaises(ValidationError):
            SceneCoordinateFrame(
                upAxis="+Z", forwardAxis="+X", units="m", handedness="right",
                customScaleToMeters=0.01,
            )

    def test_origin_is_applied_in_source_units(self):
        transform = SceneCoordinateTransform(SceneCoordinateFrame(
            upAxis="+Y", forwardAxis="+Z", units="cm", handedness="right", origin=(100, 200, 300)
        ))
        self.assertEqual(transform.point_to_canonical((100, 200, 300)), (0.0, 0.0, 0.0))
        self.assertEqual(transform.point_to_canonical((100, 300, 300)), (0.0, 0.0, 1.0))
        self.assertEqual(transform.point_from_canonical((0.0, 0.0, 1.0)), (100.0, 300.0, 300.0))

    def test_point_round_trip_for_varied_frames(self):
        configs = [
            SceneCoordinateFrame(upAxis="+Y", forwardAxis="+Z", units="m", handedness="right"),
            SceneCoordinateFrame(upAxis="-X", forwardAxis="+Y", units="mm", handedness="right", origin=(12, -4, 7)),
            SceneCoordinateFrame(upAxis="+Z", forwardAxis="-Y", units="ft", handedness="right"),
            SceneCoordinateFrame(upAxis="+Z", forwardAxis="+X", handedness="left", units="cm"),
        ]
        point = (123.4, -56.7, 8.9)
        for frame in configs:
            with self.subTest(frame=frame.model_dump()):
                transform = SceneCoordinateTransform(frame)
                round_trip = transform.point_from_canonical(transform.point_to_canonical(point))
                for actual, expected in zip(round_trip, point):
                    self.assertAlmostEqual(actual, expected, places=8)

    def test_left_handed_source_flags_mesh_winding_flip(self):
        transform = SceneCoordinateTransform(SceneCoordinateFrame(
            upAxis="+Z", forwardAxis="+X", units="m", handedness="left"
        ))
        self.assertAlmostEqual(transform.determinant, -1.0)
        self.assertTrue(transform.requires_winding_flip)
        self.assertEqual(transform.point_to_canonical((1, 2, 3)), (1.0, -2.0, 3.0))

    def test_direction_does_not_receive_translation_or_unit_scale_by_default(self):
        transform = SceneCoordinateTransform(SceneCoordinateFrame(
            upAxis="+Y", forwardAxis="+Z", units="cm", handedness="right", origin=(100, 100, 100)
        ))
        self.assertEqual(transform.vector_to_canonical((0, 1, 0)), (0.0, 0.0, 1.0))
        self.assertEqual(transform.vector_to_canonical((0, 1, 0), scale_units=True), (0.0, 0.0, 0.01))

    def test_normals_are_normalized(self):
        transform = SceneCoordinateTransform(SceneCoordinateFrame(upAxis="+Y", forwardAxis="+Z", units="m", handedness="right"))
        normal = transform.normal_to_canonical((0, 5, 0))
        self.assertEqual(normal, (0.0, 0.0, 1.0))
        with self.assertRaisesRegex(ValueError, "zero-length"):
            transform.normal_to_canonical((0, 0, 0))

    def test_rotation_conversion_preserves_proper_rotation(self):
        transform = SceneCoordinateTransform(SceneCoordinateFrame(
            upAxis="+Y", forwardAxis="+Z", units="m", handedness="left"
        ))
        converted = transform.rotation_to_canonical(((1, 0, 0), (0, 1, 0), (0, 0, 1)))
        self.assertAlmostEqual(determinant3(converted), 1.0)
        self.assertEqual(converted, ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)))
        with self.assertRaisesRegex(ValueError, "orthonormal"):
            transform.rotation_to_canonical(((2, 0, 0), (0, 1, 0), (0, 0, 1)))

    def test_bounds_transform_all_corners(self):
        frame = SceneCoordinateFrame(upAxis="+Y", forwardAxis="+Z", units="cm", handedness="right")
        transform = SceneCoordinateTransform(frame)
        source_bounds = SceneBounds(minimum=(-400, 0, -200), maximum=(400, 150, 200))
        canonical = transform.bounds_to_canonical(source_bounds)
        self.assertEqual(canonical.minimum, (-2.0, -4.0, 0.0))
        self.assertEqual(canonical.maximum, (2.0, 4.0, 1.5))

    def test_preview_response_is_serializable_and_reports_canonical_frame(self):
        req = SceneCoordinatePreviewRequest(
            frame=SceneCoordinateFrame(upAxis="+Y", forwardAxis="+Z", units="cm", handedness="right"),
            bounds=SceneBounds(minimum=(-400, 0, -200), maximum=(400, 150, 200)),
        )
        result = preview_coordinate_transform(req)
        self.assertEqual(result.canonicalFrame, CANONICAL_FRAME)
        self.assertEqual(result.scaleToMeters, 0.01)
        self.assertFalse(result.requiresWindingFlip)
        self.assertEqual(result.canonicalBounds.minimum, (-2.0, -4.0, 0.0))
        self.assertEqual(result.model_dump()["frame"]["upAxis"], "+Y")

    def test_rejects_non_finite_origin_and_bounds(self):
        with self.assertRaises(ValidationError):
            SceneCoordinateFrame(origin=(0, math.nan, 0))
        with self.assertRaises(ValidationError):
            SceneBounds(minimum=(0, 0, 0), maximum=(1, math.inf, 1))


if __name__ == "__main__":
    unittest.main()
