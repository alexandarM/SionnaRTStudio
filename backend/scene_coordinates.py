"""Universal source-scene coordinate frames and transforms.

Phase 1 of indoor-scene support. This module deliberately does not assume that
an imported scene is Y-up (or even that all scenes are right-handed). It maps a
source frame into Sionna RT's canonical world frame: right-handed, +Z up,
+X forward, metres.

The transform is an orthogonal basis change/reflection plus a uniform unit
scale and a source-origin translation. Mesh winding must be reversed when the
basis change has determinant -1; callers importing triangle meshes must honor
``requires_winding_flip``.
"""
from __future__ import annotations

from itertools import product
from math import sqrt
from typing import Literal, Sequence

from pydantic import BaseModel, ConfigDict, model_validator


SignedAxis = Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z"]
SceneUnits = Literal["m", "cm", "mm", "ft", "in", "custom"]
Handedness = Literal["right", "left"]
Vector3 = tuple[float, float, float]
Matrix3 = tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]

UNIT_TO_METERS: dict[str, float] = {
    "m": 1.0,
    "cm": 0.01,
    "mm": 0.001,
    "ft": 0.3048,
    "in": 0.0254,
}
CANONICAL_FRAME = {
    "upAxis": "+Z",
    "forwardAxis": "+X",
    "units": "m",
    "handedness": "right",
}


class SceneCoordinateFrame(BaseModel):
    """Coordinate metadata describing an imported scene's source frame.

    ``upAxis`` and ``forwardAxis`` are signed source-axis directions. They must
    be perpendicular. ``origin`` is expressed in source units and is mapped to
    the canonical origin. ``handedness`` explicitly describes the source frame
    so left-handed sources are converted with a reflection and flagged for
    triangle-winding correction.
    """

    model_config = ConfigDict(extra="forbid")

    # Required deliberately: imported source frames must never inherit an
    # assumed up axis or unit when the file format does not declare them.
    upAxis: SignedAxis
    forwardAxis: SignedAxis
    units: SceneUnits
    handedness: Handedness
    # Required only for units="custom"; useful for Blender/CAD unit scales.
    customScaleToMeters: float | None = None
    origin: Vector3 = (0.0, 0.0, 0.0)

    @model_validator(mode="after")
    def validate_basis(self) -> "SceneCoordinateFrame":
        up = axis_vector(self.upAxis)
        forward = axis_vector(self.forwardAxis)
        if abs(dot(up, forward)) > 1e-9:
            raise ValueError("upAxis and forwardAxis must be perpendicular signed axes")
        if len(self.origin) != 3 or not all(_finite(v) for v in self.origin):
            raise ValueError("origin must contain three finite coordinates")
        if self.units == "custom":
            if self.customScaleToMeters is None or not _finite(self.customScaleToMeters) or self.customScaleToMeters <= 0:
                raise ValueError("customScaleToMeters must be a positive finite number when units='custom'")
        elif self.customScaleToMeters is not None:
            raise ValueError("customScaleToMeters is only valid when units='custom'")
        return self


class SceneBounds(BaseModel):
    """Axis-aligned source-scene bounds in source units."""

    model_config = ConfigDict(extra="forbid")

    minimum: Vector3
    maximum: Vector3

    @model_validator(mode="after")
    def validate_bounds(self) -> "SceneBounds":
        if not all(_finite(v) for v in (*self.minimum, *self.maximum)):
            raise ValueError("scene bounds must contain finite coordinates")
        if any(lo > hi for lo, hi in zip(self.minimum, self.maximum)):
            raise ValueError("scene bounds minimum cannot exceed maximum")
        return self


class SceneCoordinatePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    frame: SceneCoordinateFrame
    bounds: SceneBounds


class SceneCoordinatePreviewResponse(BaseModel):
    frame: SceneCoordinateFrame
    canonicalFrame: dict
    transformMatrix: tuple[tuple[float, float, float], ...]
    translationMeters: Vector3
    scaleToMeters: float
    determinant: float
    requiresWindingFlip: bool
    canonicalBounds: SceneBounds


def _finite(value: float) -> bool:
    try:
        return float("-inf") < float(value) < float("inf")
    except (TypeError, ValueError):
        return False


def axis_vector(axis: str) -> Vector3:
    """Return a signed unit vector for ``+X``/``-X`` etc."""
    if not isinstance(axis, str) or len(axis) != 2 or axis[0] not in "+-" or axis[1] not in "XYZ":
        raise ValueError(f"Invalid signed axis: {axis!r}")
    values = [0.0, 0.0, 0.0]
    values["XYZ".index(axis[1])] = 1.0 if axis[0] == "+" else -1.0
    return tuple(values)  # type: ignore[return-value]


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return sum(float(x) * float(y) for x, y in zip(a, b))


def cross(a: Sequence[float], b: Sequence[float]) -> Vector3:
    return (
        float(a[1]) * float(b[2]) - float(a[2]) * float(b[1]),
        float(a[2]) * float(b[0]) - float(a[0]) * float(b[2]),
        float(a[0]) * float(b[1]) - float(a[1]) * float(b[0]),
    )


def determinant3(matrix: Sequence[Sequence[float]]) -> float:
    a, b, c = matrix
    return (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )


def _mat_vec(matrix: Sequence[Sequence[float]], vector: Sequence[float]) -> Vector3:
    return tuple(dot(row, vector) for row in matrix)  # type: ignore[return-value]


def _transpose(matrix: Sequence[Sequence[float]]) -> Matrix3:
    return tuple(tuple(float(matrix[r][c]) for r in range(3)) for c in range(3))  # type: ignore[return-value]


def _mat_mul(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> Matrix3:
    bt = _transpose(b)
    return tuple(tuple(dot(row, col) for col in bt) for row in a)  # type: ignore[return-value]


def _normalize(vector: Sequence[float]) -> Vector3:
    length = sqrt(dot(vector, vector))
    if length <= 1e-15:
        raise ValueError("Cannot normalize a zero-length vector")
    return tuple(float(v) / length for v in vector)  # type: ignore[return-value]


class SceneCoordinateTransform:
    """Validated source-to-canonical transformation.

    Canonical Sionna frame:
      * +Z is up
      * +X is forward
      * right-handed
      * positions and lengths are in metres

    Mapping convention: ``p_canonical = R @ (p_source - origin) * scale``.
    """

    def __init__(self, frame: SceneCoordinateFrame):
        self.frame = frame
        up = axis_vector(frame.upAxis)
        forward = axis_vector(frame.forwardAxis)
        if abs(dot(up, forward)) > 1e-9:
            raise ValueError("upAxis and forwardAxis must be perpendicular")

        lateral = cross(up, forward)
        if frame.handedness == "left":
            lateral = tuple(-v for v in lateral)  # type: ignore[assignment]

        # Matrix rows are canonical forward, lateral, and up expressed in source
        # coordinates. Its determinant is +1 for RH input and -1 for LH input.
        self.matrix: Matrix3 = (forward, lateral, up)  # type: ignore[assignment]
        self.inverse_matrix: Matrix3 = _transpose(self.matrix)
        self.scale_to_meters = (
            float(frame.customScaleToMeters)
            if frame.units == "custom" and frame.customScaleToMeters is not None
            else UNIT_TO_METERS[frame.units]
        )
        self.determinant = determinant3(self.matrix)
        self.requires_winding_flip = self.determinant < 0.0
        self.translation_meters: Vector3 = tuple(
            -v * self.scale_to_meters
            for v in _mat_vec(self.matrix, frame.origin)
        )  # type: ignore[assignment]

    def point_to_canonical(self, point: Sequence[float]) -> Vector3:
        """Transform a source position to canonical metres."""
        if len(point) != 3 or not all(_finite(v) for v in point):
            raise ValueError("point must contain three finite coordinates")
        relative = tuple(float(p) - float(o) for p, o in zip(point, self.frame.origin))
        mapped = _mat_vec(self.matrix, relative)
        return tuple(v * self.scale_to_meters for v in mapped)  # type: ignore[return-value]

    def point_from_canonical(self, point: Sequence[float]) -> Vector3:
        """Transform a canonical-metre position back to source coordinates."""
        if len(point) != 3 or not all(_finite(v) for v in point):
            raise ValueError("point must contain three finite coordinates")
        scaled = tuple(float(v) / self.scale_to_meters for v in point)
        relative = _mat_vec(self.inverse_matrix, scaled)
        return tuple(v + o for v, o in zip(relative, self.frame.origin))  # type: ignore[return-value]

    def vector_to_canonical(self, vector: Sequence[float], *, scale_units: bool = False) -> Vector3:
        """Transform a direction/vector; translation is never applied.

        Set ``scale_units=True`` for dimensional vectors such as velocity or
        displacement. For pure directions/orientations leave it false.
        """
        if len(vector) != 3 or not all(_finite(v) for v in vector):
            raise ValueError("vector must contain three finite coordinates")
        mapped = _mat_vec(self.matrix, vector)
        scale = self.scale_to_meters if scale_units else 1.0
        return tuple(v * scale for v in mapped)  # type: ignore[return-value]

    def normal_to_canonical(self, normal: Sequence[float]) -> Vector3:
        """Transform and normalize a surface normal."""
        return _normalize(self.vector_to_canonical(normal))

    def rotation_to_canonical(self, rotation: Sequence[Sequence[float]]) -> Matrix3:
        """Convert a proper source-frame 3x3 orientation matrix.

        The conjugation also handles a left-handed source coordinate basis while
        keeping the resulting physical rotation matrix proper (determinant +1).
        """
        if len(rotation) != 3 or any(len(row) != 3 for row in rotation):
            raise ValueError("rotation must be a 3x3 matrix")
        q = tuple(tuple(float(v) for v in row) for row in rotation)
        if not all(_finite(v) for row in q for v in row):
            raise ValueError("rotation must contain finite values")
        qtq = _mat_mul(_transpose(q), q)
        for r in range(3):
            for c in range(3):
                expected = 1.0 if r == c else 0.0
                if abs(qtq[r][c] - expected) > 1e-6:
                    raise ValueError("rotation must be orthonormal")
        if abs(determinant3(q) - 1.0) > 1e-6:
            raise ValueError("rotation must be a proper rotation (determinant +1)")
        return _mat_mul(_mat_mul(self.matrix, q), self.inverse_matrix)

    def bounds_to_canonical(self, bounds: SceneBounds) -> SceneBounds:
        """Transform all eight AABB corners and return their canonical AABB."""
        corners = [
            (x, y, z)
            for x, y, z in product(
                (bounds.minimum[0], bounds.maximum[0]),
                (bounds.minimum[1], bounds.maximum[1]),
                (bounds.minimum[2], bounds.maximum[2]),
            )
        ]
        transformed = [self.point_to_canonical(corner) for corner in corners]
        return SceneBounds(
            minimum=tuple(min(point[i] for point in transformed) for i in range(3)),
            maximum=tuple(max(point[i] for point in transformed) for i in range(3)),
        )

    def preview(self, bounds: SceneBounds) -> SceneCoordinatePreviewResponse:
        return SceneCoordinatePreviewResponse(
            frame=self.frame,
            canonicalFrame=dict(CANONICAL_FRAME),
            transformMatrix=self.matrix,
            translationMeters=self.translation_meters,
            scaleToMeters=self.scale_to_meters,
            determinant=self.determinant,
            requiresWindingFlip=self.requires_winding_flip,
            canonicalBounds=self.bounds_to_canonical(bounds),
        )


def preview_coordinate_transform(request: SceneCoordinatePreviewRequest) -> SceneCoordinatePreviewResponse:
    """Build a serializable preview; does not load or mutate any RT scene."""
    return SceneCoordinateTransform(request.frame).preview(request.bounds)
