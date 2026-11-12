"""Runtime activation of staged indoor scenes in Sionna RT.

The indoor runtime canonicalizes each source mesh into the same
RH/+Z-up/+X-forward metre frame as the viewport, loads it as a real Sionna RT
scene, registers runtime TX/RX devices and arrays, and executes selected indoor
PathSolver links without rebuilding outdoor geometry.
"""
from __future__ import annotations

import importlib.metadata
import logging
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
from .scene_coordinates import SceneCoordinateFrame, SceneCoordinateTransform
from .scene_import import (
    SceneImportError,
    SceneImportSession,
    _load_preview_mesh,
    _matrix_for_shape,
    _resolve_resource,
    _safe_archive_path,
    _xml_bytes_to_root,
)

logger = logging.getLogger(__name__)
RUNTIME_DIR_NAME = "__sionna_runtime__"
MAX_RUNTIME_SHAPES = 10_000
DEFAULT_CARRIER_FREQUENCY_GHZ = 28.0


class IndoorSceneActivationError(ValueError):
    """A staged indoor scene cannot be safely activated in Sionna RT."""


@dataclass
class ActiveIndoorScene:
    session_id: str
    scene: Any
    carrier_frequency_ghz: float
    material_mappings: dict[str, str]
    summary: dict[str, Any]
    activated_at: str
    canonical_xml_path: str
    device_names: dict[str, list[str]]
    device_sync_summary: dict[str, Any] | None = None


_ACTIVE_SCENE: ActiveIndoorScene | None = None
_RUNTIME_STATE_LOCK = threading.RLock()


def _runtime_imports():
    """Import Sionna lazily so archive inspection still works without RT deps."""
    try:
        import mitsuba as mi
        import sionna
        from sionna.rt import load_scene
        from sionna.rt.radio_materials.itu import ITU_MATERIALS_PROPERTIES
        from sionna.rt.radio_materials import RadioMaterialBase
    except Exception as exc:  # noqa: BLE001 - report a useful runtime dependency error
        raise IndoorSceneActivationError(
            "Sionna RT runtime is unavailable. Start the backend with its configured "
            "Mitsuba/Dr.Jit/Sionna environment before activating an indoor scene. "
            f"Runtime import error: {exc}"
        ) from exc
    try:
        sionna_version = importlib.metadata.version("sionna-rt")
    except importlib.metadata.PackageNotFoundError:
        sionna_version = getattr(sionna, "__version__", "unknown")
    try:
        variant = mi.variant() or "unknown"
    except Exception:  # noqa: BLE001
        variant = "unknown"
    return mi, load_scene, ITU_MATERIALS_PROPERTIES, RadioMaterialBase, str(sionna_version), str(variant)


def get_indoor_material_catalog() -> dict[str, Any]:
    """Return the actual installed Sionna ITU catalogue and supported bands."""
    _mi, _load_scene, properties, _base, version, variant = _runtime_imports()
    materials: list[dict[str, Any]] = []
    for name, ranges in sorted(properties.items()):
        materials.append({
            "name": str(name),
            "frequencyRangesGhz": [
                {"minimum": float(bounds[0]), "maximum": float(bounds[1])}
                for bounds in ranges.keys()
            ],
        })
    return {
        "runtime": "Sionna RT",
        "version": version,
        "mitsubaVariant": variant,
        "materials": materials,
    }


def _validate_frequency_materials(
    material_mappings: dict[str, str],
    frequency_ghz: float,
    properties: dict[str, Any],
) -> None:
    if not np.isfinite(frequency_ghz) or frequency_ghz <= 0 or frequency_ghz > 300:
        raise IndoorSceneActivationError("Carrier frequency must be a finite value between 0 and 300 GHz.")
    for source_id, material_name in sorted(material_mappings.items()):
        ranges = properties.get(material_name)
        if ranges is None:
            raise IndoorSceneActivationError(
                f"Material '{source_id}' maps to unknown Sionna ITU material '{material_name}'. "
                "Choose a material from the installed Sionna RT catalogue."
            )
        supported = [bounds for bounds in ranges if float(bounds[0]) <= frequency_ghz <= float(bounds[1])]
        if not supported:
            bands = ", ".join(f"{float(lo):g}–{float(hi):g} GHz" for lo, hi in ranges)
            raise IndoorSceneActivationError(
                f"Material '{source_id}' → '{material_name}' does not support {frequency_ghz:g} GHz. "
                f"Supported range(s): {bands}. Choose a different mapping or carrier frequency."
            )


def _clean_shape_id(raw: str, index: int) -> str:
    value = (raw or f"shape_{index + 1}").strip()
    if not value or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value):
        raise IndoorSceneActivationError(f"Shape {index + 1} has an invalid Mitsuba id: {raw!r}")
    return value


def _canonical_mesh_bytes(
    session: SceneImportSession,
    xml_path: str,
    filename_value: str,
    shape: ET.Element,
    transformer: SceneCoordinateTransform,
    output_path: Path,
) -> tuple[int, int, np.ndarray, np.ndarray]:
    try:
        resource = _resolve_resource(xml_path, filename_value)
    except SceneImportError as exc:
        raise IndoorSceneActivationError(
            f"Shape '{shape.attrib.get('id', '')}' has an unsafe or invalid mesh resource path: {exc}"
        ) from exc
    source_path = session.root.joinpath(*PurePosixPath(resource).parts)
    if not source_path.is_file():
        raise IndoorSceneActivationError(f"Shape '{shape.attrib.get('id', '')}' is missing mesh resource '{resource}'.")
    try:
        mesh = _load_preview_mesh(source_path.read_bytes(), resource)
    except SceneImportError as exc:
        raise IndoorSceneActivationError(str(exc)) from exc

    source_matrix, transform_warnings = _matrix_for_shape(shape)
    if transform_warnings:
        raise IndoorSceneActivationError(
            f"Shape '{shape.attrib.get('id', '')}' has a Mitsuba transform that cannot be applied safely: "
            + "; ".join(transform_warnings)
        )
    if not np.allclose(source_matrix[3], np.asarray([0.0, 0.0, 0.0, 1.0]), atol=1e-9):
        raise IndoorSceneActivationError(
            f"Shape '{shape.attrib.get('id', '')}' uses a non-affine transform; activation was stopped."
        )
    linear_det = float(np.linalg.det(source_matrix[:3, :3]))
    if abs(linear_det) < 1e-12:
        raise IndoorSceneActivationError(f"Shape '{shape.attrib.get('id', '')}' has a singular transform.")

    source_vertices = np.asarray(mesh.vertices, dtype=np.float64)
    homogeneous = np.column_stack((source_vertices, np.ones(len(source_vertices), dtype=np.float64)))
    transformed_source = (source_matrix @ homogeneous.T).T[:, :3]
    canonical = np.asarray([transformer.point_to_canonical(vertex) for vertex in transformed_source], dtype=np.float64)
    if not np.isfinite(canonical).all():
        raise IndoorSceneActivationError(f"Shape '{shape.attrib.get('id', '')}' produced non-finite canonical coordinates.")
    mesh.vertices = canonical
    if transformer.determinant * linear_det < 0:
        mesh.faces = np.asarray(mesh.faces, dtype=np.int64)[:, [0, 2, 1]]
    mesh.fix_normals(multibody=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        output_path.write_bytes(mesh.export(file_type="ply", encoding="binary_little_endian"))
    except Exception as exc:  # noqa: BLE001
        raise IndoorSceneActivationError(f"Could not write canonical PLY for shape '{shape.attrib.get('id', '')}': {exc}") from exc
    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    return len(mesh.vertices), len(mesh.faces), bounds[0], bounds[1]


def _replace_shape_transform(shape: ET.Element) -> None:
    for child in list(shape):
        if child.tag.split("}")[-1].lower() == "transform" and child.attrib.get("name") in (None, "to_world"):
            shape.remove(child)


def _rewrite_bsdf_as_itu(bsdf: ET.Element, material_name: str) -> None:
    """Replace visual BSDF graph with a genuine Sionna ITU plugin declaration."""
    thickness = next(
        (child.attrib.get("value") for child in list(bsdf)
         if child.tag.split("}")[-1].lower() == "float" and child.attrib.get("name") == "thickness"),
        None,
    )
    bsdf.attrib["type"] = "itu-radio-material"
    for child in list(bsdf):
        bsdf.remove(child)
    ET.SubElement(bsdf, "string", {"name": "type", "value": material_name})
    if thickness is not None:
        ET.SubElement(bsdf, "float", {"name": "thickness", "value": str(thickness)})


def _build_canonical_scene_xml(
    session: SceneImportSession,
    material_mappings: dict[str, str],
    frequency_ghz: float,
    itu_properties: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    xml_relative = _safe_archive_path(str(session.manifest.get("xmlPath", "")))
    source_xml_path = session.root.joinpath(*PurePosixPath(xml_relative).parts)
    if not source_xml_path.is_file():
        raise IndoorSceneActivationError(f"Staged Mitsuba XML is missing: {xml_relative}")
    try:
        xml_bytes = source_xml_path.read_bytes()
        root = _xml_bytes_to_root(xml_bytes)
    except (OSError, SceneImportError) as exc:
        raise IndoorSceneActivationError(f"Could not read staged Mitsuba XML: {exc}") from exc

    includes = [node for node in root.iter() if node.tag.split("}")[-1].lower() == "include"]
    if includes:
        raise IndoorSceneActivationError(
            "This scene uses nested Mitsuba XML <include> fragments. Phase 6.1 currently requires a self-contained "
            "single-scene XML so every shape can receive the canonical transform; import the included XML content "
            "into the root scene before activation."
        )

    transformer = SceneCoordinateTransform(SceneCoordinateFrame.model_validate(session.manifest["coordinateFrame"]))

    shape_nodes = [node for node in list(root) if node.tag.split("}")[-1].lower() == "shape"]
    all_shape_nodes = [node for node in root.iter() if node.tag.split("}")[-1].lower() == "shape"]
    if len(all_shape_nodes) != len(shape_nodes):
        raise IndoorSceneActivationError(
            "Nested Mitsuba <shape> nodes are not supported in Phase 6.1. Flatten the shapegroup/instance "
            "structure into top-level mesh shapes before activation; no nested geometry is silently omitted."
        )
    unsupported_geometry_nodes = [
        node for node in root.iter()
        if node.tag.split("}")[-1].lower() in {"instance", "shapegroup"}
    ]
    if unsupported_geometry_nodes:
        raise IndoorSceneActivationError(
            "Mitsuba <shapegroup>/<instance> geometry is not supported in Phase 6.1. Expand instances into "
            "individual top-level mesh shapes before activation."
        )
    if not shape_nodes:
        raise IndoorSceneActivationError("The Mitsuba XML contains no top-level shape objects to activate.")
    if len(shape_nodes) > MAX_RUNTIME_SHAPES:
        raise IndoorSceneActivationError(f"Scene contains too many shape objects ({len(shape_nodes)}).")

    bsdf_nodes = [node for node in list(root) if node.tag.split("}")[-1].lower() == "bsdf"]
    bsdf_by_id = {node.attrib.get("id"): node for node in bsdf_nodes if node.attrib.get("id")}
    if len(bsdf_by_id) != len(bsdf_nodes):
        raise IndoorSceneActivationError("Every top-level BSDF must have a unique id before Sionna activation.")

    refs_by_shape: dict[str, str] = {}
    used_material_ids: set[str] = set()
    shape_ids: set[str] = set()
    for index, shape in enumerate(shape_nodes):
        shape_id = _clean_shape_id(shape.attrib.get("id", ""), index)
        shape.attrib["id"] = shape_id
        if shape_id in shape_ids:
            raise IndoorSceneActivationError(f"Duplicate Mitsuba shape id '{shape_id}' is not supported.")
        shape_ids.add(shape_id)
        shape_transforms = [
            node for node in list(shape)
            if node.tag.split("}")[-1].lower() == "transform"
            and node.attrib.get("name") in (None, "to_world")
        ]
        if len(shape_transforms) > 1:
            raise IndoorSceneActivationError(
                f"Shape '{shape_id}' contains multiple to_world transforms; a single unambiguous transform is required."
            )
        shape_type = shape.attrib.get("type", "").casefold()
        if shape_type not in {"ply", "obj", "stl", "off"}:
            raise IndoorSceneActivationError(
                f"Shape '{shape_id}' uses '{shape_type or 'unknown'}', which Phase 6.1 cannot canonicalize. "
                "Only triangle mesh shapes (PLY/OBJ/STL/OFF) are accepted; no shapes are silently omitted."
            )
        filename_node = next((n for n in shape.iter() if n.tag.split("}")[-1].lower() == "string" and n.attrib.get("name") == "filename"), None)
        if filename_node is None or not filename_node.attrib.get("value"):
            raise IndoorSceneActivationError(f"Mesh shape '{shape_id}' has no filename resource.")
        refs = [n.attrib.get("id") for n in shape.iter() if n.tag.split("}")[-1].lower() == "ref" and n.attrib.get("id")]
        if len(refs) != 1:
            raise IndoorSceneActivationError(f"Shape '{shape_id}' must reference exactly one top-level radio material; found {len(refs)}.")
        material_id = str(refs[0])
        if material_id not in bsdf_by_id:
            raise IndoorSceneActivationError(f"Shape '{shape_id}' references undefined material id '{material_id}'.")
        refs_by_shape[shape_id] = material_id
        used_material_ids.add(material_id)

    missing_mappings = sorted(source_id for source_id in used_material_ids if not material_mappings.get(source_id))
    if missing_mappings:
        labels = ", ".join(missing_mappings[:8])
        suffix = " …" if len(missing_mappings) > 8 else ""
        raise IndoorSceneActivationError(
            f"Map every referenced source material to an installed Sionna ITU material before activation. Missing: {labels}{suffix}."
        )
    effective_mappings = {source_id: str(material_mappings[source_id]) for source_id in sorted(used_material_ids)}
    _validate_frequency_materials(effective_mappings, frequency_ghz, itu_properties)

    runtime_root = session.root / RUNTIME_DIR_NAME
    mesh_root = runtime_root / "meshes"
    mesh_root.mkdir(parents=True, exist_ok=True)
    # Remove only stale files generated by this activation builder. Original
    # imported resources are kept intact in the parent session directory.
    for stale in mesh_root.glob("*.ply"):
        try:
            stale.unlink()
        except OSError:
            pass

    aggregate_min = np.asarray([np.inf, np.inf, np.inf], dtype=np.float64)
    aggregate_max = np.asarray([-np.inf, -np.inf, -np.inf], dtype=np.float64)
    total_vertices = 0
    total_faces = 0
    for index, shape in enumerate(shape_nodes):
        shape_id = str(shape.attrib["id"])
        filename_node = next(n for n in shape.iter() if n.tag.split("}")[-1].lower() == "string" and n.attrib.get("name") == "filename")
        filename_value = filename_node.attrib["value"]
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", shape_id)[:80]
        output_path = mesh_root / f"{index:04d}-{safe_name}.ply"
        vertices, faces, bounds_min, bounds_max = _canonical_mesh_bytes(
            session, xml_relative, filename_value, shape, transformer, output_path
        )
        total_vertices += vertices
        total_faces += faces
        aggregate_min = np.minimum(aggregate_min, bounds_min)
        aggregate_max = np.maximum(aggregate_max, bounds_max)
        filename_node.attrib["value"] = Path(os.path.relpath(output_path, start=source_xml_path.parent)).as_posix()
        shape.attrib["type"] = "ply"
        _replace_shape_transform(shape)

    for material_id in list(bsdf_by_id):
        if material_id in used_material_ids:
            _rewrite_bsdf_as_itu(bsdf_by_id[material_id], effective_mappings[material_id])
        else:
            # Unused visual BSDFs are not part of the RF scene. Removing them
            # prevents unrelated Blender preview shaders from being parsed as
            # Sionna radio materials merely because their IDs have an ITU hint.
            root.remove(bsdf_by_id[material_id])

    runtime_xml_path = source_xml_path.with_name(f"{source_xml_path.stem}.sionna-runtime.xml")
    ET.indent(root, space="    ")
    runtime_xml_path.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    summary = {
        "shapeCount": len(shape_nodes),
        "materialCount": len(used_material_ids),
        "vertexCount": total_vertices,
        "faceCount": total_faces,
        "materialMappings": effective_mappings,
        "canonicalBounds": {
            "minimum": aggregate_min.round(6).tolist(),
            "maximum": aggregate_max.round(6).tolist(),
        },
        "coordinateFrame": {"upAxis": "+Z", "forwardAxis": "+X", "units": "m", "handedness": "right"},
    }
    return runtime_xml_path, summary


def activate_indoor_scene(
    session: SceneImportSession,
    material_mappings: dict[str, str],
    carrier_frequency_ghz: float = DEFAULT_CARRIER_FREQUENCY_GHZ,
) -> dict[str, Any]:
    """Build and activate a real Sionna scene; returns only after registry checks."""
    global _ACTIVE_SCENE
    mi, load_scene, properties, material_base, version, variant = _runtime_imports()
    if not isinstance(material_mappings, dict):
        raise IndoorSceneActivationError("materialMappings must be an object mapping original XML material IDs to ITU types.")

    xml_path, summary = _build_canonical_scene_xml(
        session, material_mappings, float(carrier_frequency_ghz), properties
    )
    try:
        # Keeping shapes separate is essential: the editor and later TX/RX
        # placement need stable object identities, not a merged mesh.
        scene = load_scene(str(xml_path), merge_shapes=False, remove_duplicate_vertices=False)
        scene.frequency = float(carrier_frequency_ghz) * 1e9
    except Exception as exc:  # noqa: BLE001
        raise IndoorSceneActivationError(
            "Sionna RT could not instantiate the canonical indoor scene. "
            f"The previous active scene has not been marked as replaced. Runtime error: {exc}"
        ) from exc

    scene_objects = getattr(scene, "objects", None)
    radio_materials = getattr(scene, "radio_materials", None)
    if not isinstance(scene_objects, dict) or len(scene_objects) != summary["shapeCount"]:
        actual_count = len(scene_objects) if hasattr(scene_objects, "__len__") else "unknown"
        raise IndoorSceneActivationError(
            f"Sionna loaded {actual_count} scene objects, but {summary['shapeCount']} source shapes were expected. "
            "The scene was not marked active."
        )
    if not isinstance(radio_materials, dict):
        raise IndoorSceneActivationError("Sionna scene does not expose the expected radio-material registry.")

    for object_name, scene_object in scene_objects.items():
        mesh = getattr(scene_object, "mi_mesh", None)
        radio_material = getattr(scene_object, "radio_material", None)
        if mesh is None:
            raise IndoorSceneActivationError(f"Sionna scene object '{object_name}' has no Mitsuba mesh.")
        if not isinstance(radio_material, material_base):
            raise IndoorSceneActivationError(
                f"Sionna scene object '{object_name}' is not assigned a registered RadioMaterial."
            )
    registered_material_objects = {id(item) for item in radio_materials.values()}
    for object_name, scene_object in scene_objects.items():
        if id(getattr(scene_object, "radio_material", None)) not in registered_material_objects:
            raise IndoorSceneActivationError(
                f"Sionna object '{object_name}' references a radio material that is absent from the scene registry."
            )
    if len(radio_materials) < summary["materialCount"]:
        raise IndoorSceneActivationError(
            f"Sionna registered {len(radio_materials)} radio materials, but {summary['materialCount']} distinct "
            "referenced source material IDs were expected."
        )

    activated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    runtime_summary = {
        **summary,
        "activation": "active",
        "carrierFrequencyGhz": float(carrier_frequency_ghz),
        "sionnaVersion": version,
        "mitsubaVariant": variant,
        "registeredObjectCount": len(scene_objects),
        "registeredRadioMaterialCount": len(radio_materials),
        "activatedAt": activated_at,
    }
    active = ActiveIndoorScene(
        session_id=session.session_id,
        scene=scene,
        carrier_frequency_ghz=float(carrier_frequency_ghz),
        material_mappings=dict(summary["materialMappings"]),
        summary=runtime_summary,
        activated_at=activated_at,
        canonical_xml_path=str(xml_path),
        device_names={"tx": [], "rx": []},
        device_sync_summary=None,
    )
    with _RUNTIME_STATE_LOCK:
        _ACTIVE_SCENE = active
    logger.info(
        "Activated indoor Sionna RT scene %s: %d shapes, %d materials, %s GHz (%s)",
        session.session_id, len(scene_objects), len(radio_materials), carrier_frequency_ghz, variant,
    )
    return get_indoor_scene_runtime_status()



def _device_runtime_imports(scene: Any | None = None):
    """Load radio classes from the exact Sionna module that owns ``scene``.

    The Scene.tx_array/rx_array setters validate against the ``AntennaArray``
    class in the globals of the concrete Scene class. Importing PlanarArray
    from a second/re-exported Sionna module can produce a class-identity
    mismatch after notebook reloads or partially reloaded runtimes, even when
    both classes print the same qualified name. Resolve the array base from
    the active Scene implementation, then import PlanarArray from that base
    class's defining module. Radio-device classes are taken from the same
    Scene module because Scene.add() uses those exact globals for isinstance.
    """
    try:
        if scene is None:
            from sionna.rt import AntennaArray, PlanarArray, Receiver, Transmitter
        else:
            scene_module = importlib.import_module(type(scene).__module__)
            AntennaArray = getattr(scene_module, "AntennaArray")
            antenna_module = importlib.import_module(AntennaArray.__module__)
            PlanarArray = getattr(antenna_module, "PlanarArray")
            Transmitter = getattr(scene_module, "Transmitter")
            Receiver = getattr(scene_module, "Receiver")
        if not isinstance(AntennaArray, type) or not isinstance(PlanarArray, type):
            raise TypeError("Sionna AntennaArray/PlanarArray exports are not classes")
        if not issubclass(PlanarArray, AntennaArray):
            raise TypeError(
                "The active Scene expects "
                f"{AntennaArray.__module__}.{AntennaArray.__qualname__}, but "
                f"{PlanarArray.__module__}.{PlanarArray.__qualname__} does not inherit from it"
            )
    except Exception as exc:  # noqa: BLE001
        raise IndoorSceneActivationError(
            "Sionna RT radio-device classes could not be resolved from the active "
            f"Scene implementation: {exc}"
        ) from exc
    return PlanarArray, Transmitter, Receiver, AntennaArray


def _restore_scene_array(scene: Any, side: str, previous: Any) -> None:
    """Restore a scene-level array without passing ``None`` to Sionna setters.

    Sionna RT 2.0.1 setters deliberately accept only AntennaArray instances.
    A newly activated scene starts with ``None`` arrays, so rollback must
    restore the private backing slot for that initial state. Non-empty prior
    arrays still go through the public validated property setter.
    """
    if side not in ("tx", "rx"):
        raise ValueError(f"Unknown antenna-array side: {side}")
    if previous is None:
        backing_name = f"_{side}_array"
        if hasattr(scene, backing_name):
            setattr(scene, backing_name, None)
        else:
            # Lightweight test doubles may expose plain attributes rather
            # than Sionna's validated properties.
            setattr(scene, f"{side}_array", None)
    else:
        setattr(scene, f"{side}_array", previous)


def _finite_vector(value: Any, length: int, label: str) -> np.ndarray:
    try:
        vector = np.asarray(value, dtype=np.float64)
    except Exception as exc:  # noqa: BLE001
        raise IndoorSceneActivationError(f"{label} must contain {length} finite numbers.") from exc
    if vector.shape != (length,) or not np.isfinite(vector).all():
        raise IndoorSceneActivationError(f"{label} must contain {length} finite numbers.")
    return vector


def _normalize_quaternion_xyzw(value: Any, label: str) -> np.ndarray:
    if value is None:
        return np.asarray([0.0, 0.0, 0.0, 1.0], dtype=np.float64)
    quaternion = _finite_vector(value, 4, label)
    norm = float(np.linalg.norm(quaternion))
    if norm <= 1e-12:
        raise IndoorSceneActivationError(f"{label} cannot be a zero-length quaternion.")
    return quaternion / norm


def _quaternion_multiply_xyzw(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    """Hamilton product for [x,y,z,w] quaternions; applies right, then left."""
    lx, ly, lz, lw = left
    rx, ry, rz, rw = right
    return np.asarray([
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    ], dtype=np.float64)


def _quaternion_matrix_xyzw(quaternion: np.ndarray) -> np.ndarray:
    x, y, z, w = _normalize_quaternion_xyzw(quaternion, "orientation quaternion")
    return np.asarray([
        [1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
        [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
        [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)],
    ], dtype=np.float64)


# Maps the canonical device-local frame (+Z boresight, XY array plane) to
# Sionna's radio-device frame (+X boresight, YZ PlanarArray plane). The columns
# are canonical +X,+Y,+Z represented in Sionna-local coordinates.
_SIONNA_TO_CANONICAL_DEVICE_BASIS = np.asarray([
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 0.0],
], dtype=np.float64)


def _steering_quaternion_xyzw(azimuth_deg: float, elevation_deg: float) -> np.ndarray:
    """Rotate canonical local +Z boresight toward (+X azimuth, +Y elevation)."""
    if not np.isfinite(azimuth_deg) or not np.isfinite(elevation_deg):
        raise IndoorSceneActivationError("Indoor beam-steering angles must be finite.")
    if abs(float(elevation_deg)) > 90.0 or abs(float(azimuth_deg)) > 180.0:
        raise IndoorSceneActivationError("Indoor steering azimuth must be within ±180° and elevation within ±90°.")
    azimuth = np.deg2rad(float(azimuth_deg))
    elevation = np.deg2rad(float(elevation_deg))
    direction = np.asarray([
        np.cos(elevation) * np.sin(azimuth),
        np.sin(elevation),
        np.cos(elevation) * np.cos(azimuth),
    ], dtype=np.float64)
    source = np.asarray([0.0, 0.0, 1.0], dtype=np.float64)
    dot_value = float(np.clip(np.dot(source, direction), -1.0, 1.0))
    if dot_value > 1.0 - 1e-12:
        return np.asarray([0.0, 0.0, 0.0, 1.0], dtype=np.float64)
    if dot_value < -1.0 + 1e-12:
        return np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float64)
    axis = np.cross(source, direction)
    axis /= np.linalg.norm(axis)
    half_angle = 0.5 * np.arccos(dot_value)
    return np.asarray([*(axis * np.sin(half_angle)), np.cos(half_angle)], dtype=np.float64)


def canonical_device_orientation_to_sionna_euler(
    orientation_xyzw: Any = None,
    *,
    steering_azimuth_deg: float = 0.0,
    steering_elevation_deg: float = 0.0,
) -> tuple[float, float, float]:
    """Convert canonical mount quaternion + local TX steering to Sionna Euler.

    Sionna uses Rz(alpha) @ Ry(beta) @ Rx(gamma), with its local +X as
    boresight. The canonical editor uses [x,y,z,w] and local +Z boresight.
    """
    mounted = _normalize_quaternion_xyzw(orientation_xyzw, "sceneOrientation")
    steering = _steering_quaternion_xyzw(steering_azimuth_deg, steering_elevation_deg)
    canonical_rotation = _quaternion_matrix_xyzw(_quaternion_multiply_xyzw(mounted, steering))
    # Matrix maps Sionna-local axes into canonical device-local axes:
    # Sionna +X (boresight) -> canonical +Z; +Y (array columns) -> +X;
    # +Z (array rows) -> +Y. Thus both boresight and the 2-D array layout
    # match the editor's canonical XY array / +Z boresight convention.
    sionna_rotation = canonical_rotation @ _SIONNA_TO_CANONICAL_DEVICE_BASIS
    # Stable Z-Y-X extraction from Rz(alpha) Ry(beta) Rx(gamma).
    beta = float(np.arcsin(np.clip(-sionna_rotation[2, 0], -1.0, 1.0)))
    cos_beta = float(np.cos(beta))
    if abs(cos_beta) > 1e-8:
        alpha = float(np.arctan2(sionna_rotation[1, 0], sionna_rotation[0, 0]))
        gamma = float(np.arctan2(sionna_rotation[2, 1], sionna_rotation[2, 2]))
    else:
        # At gimbal lock gamma is set to zero; the remaining combined yaw is
        # retained in alpha so the resulting rotation matrix is still exact.
        alpha = float(np.arctan2(-sionna_rotation[0, 1], sionna_rotation[1, 1]))
        gamma = 0.0
    return alpha, beta, gamma


def _array_dimensions(devices: list[Any], kind: str) -> tuple[int, int]:
    dimensions: set[tuple[int, int]] = set()
    for device in devices:
        try:
            columns, rows = (int(device.antennaArraySize[0]), int(device.antennaArraySize[1]))
        except Exception as exc:  # noqa: BLE001
            raise IndoorSceneActivationError(f"{kind} '{device.id}' has an invalid antennaArraySize [columns, rows].") from exc
        if columns < 1 or rows < 1 or columns > 64 or rows > 64:
            raise IndoorSceneActivationError(f"{kind} '{device.id}' array dimensions must be within 1…64 per axis.")
        dimensions.add((columns, rows))
    if len(dimensions) != 1:
        raise IndoorSceneActivationError(
            f"All indoor {kind} devices must use the same scene-level PlanarArray dimensions. "
            f"Found: {sorted(dimensions)}. Configure compatible arrays before synchronizing."
        )
    return next(iter(dimensions))


def _runtime_device_name(kind: str, device_id: str) -> str:
    import hashlib
    digest = hashlib.sha256(str(device_id).encode("utf-8")).hexdigest()[:16]
    return f"app_{kind}_{digest}"


def _make_scene_device(device: Any, *, kind: str, session_id: str, device_class: Any) -> tuple[Any, dict[str, Any]]:
    if getattr(device, "sceneSessionId", None) != session_id:
        raise IndoorSceneActivationError(
            f"{kind.upper()} '{device.id}' belongs to scene session '{getattr(device, 'sceneSessionId', None)}', "
            f"not the active session '{session_id}'. Re-place the device in the currently active scene."
        )
    position = _finite_vector(getattr(device, "scenePosition", None), 3, f"{kind.upper()} '{device.id}' scenePosition")
    orientation = getattr(device, "sceneOrientation", None)
    steering_azimuth = 0.0
    steering_elevation = 0.0
    if kind == "tx" and getattr(device, "beamSteeringFrame", "world_enu") == "device_local":
        steering = getattr(device, "indoorBeamSteering", None)
        if steering is not None:
            steering_azimuth = float(getattr(steering, "azimuthDeg", 0.0))
            steering_elevation = float(getattr(steering, "elevationDeg", 0.0))
    euler = canonical_device_orientation_to_sionna_euler(
        orientation,
        steering_azimuth_deg=steering_azimuth,
        steering_elevation_deg=steering_elevation,
    )
    name = _runtime_device_name(kind, str(device.id))
    if kind == "tx":
        power_dbm = float(getattr(device, "powerDbm", 30.0))
        if not np.isfinite(power_dbm) or not -100.0 <= power_dbm <= 100.0:
            raise IndoorSceneActivationError(f"TX '{device.id}' power must be finite and within -100…100 dBm.")
        instance = device_class(
            name=name,
            position=tuple(float(v) for v in position),
            orientation=euler,
            power_dbm=power_dbm,
        )
    else:
        instance = device_class(
            name=name,
            position=tuple(float(v) for v in position),
            orientation=canonical_device_orientation_to_sionna_euler(orientation),
        )
    return instance, {
        "id": str(device.id),
        "name": str(getattr(device, "name", device.id)),
        "runtimeName": name,
        "position": position.tolist(),
        "orientationEulerRad": [float(v) for v in euler],
        "antennaArraySize": [int(device.antennaArraySize[0]), int(device.antennaArraySize[1])],
        **({"powerDbm": power_dbm, "steeringAzimuthDeg": steering_azimuth,
            "steeringElevationDeg": steering_elevation} if kind == "tx" else {}),
    }


def sync_indoor_scene_devices(
    session_id: str,
    txs: list[Any],
    rxs: list[Any],
    carrier_frequency_ghz: float,
    solver_options: Any,
) -> dict[str, Any]:
    """Apply the latest viewport TX/RX state to the already-active Sionna scene.

    This is internal solve preparation, not a user-facing synchronization step.
    The indoor geometry and radio materials are deliberately left untouched.
    """
    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
    if active is None or active.session_id != session_id:
        raise IndoorSceneActivationError("The requested indoor scene is not the active Sionna RT scene.")
    if not txs or not rxs:
        raise IndoorSceneActivationError("Place at least one TX and one RX in the active indoor scene before synchronizing.")
    _mi, _load_scene, itu_properties, _material_base, _version, _variant = _runtime_imports()
    _validate_frequency_materials(active.material_mappings, float(carrier_frequency_ghz), itu_properties)
    if not np.isfinite(carrier_frequency_ghz) or not 0 < float(carrier_frequency_ghz) <= 300:
        raise IndoorSceneActivationError("Carrier frequency must be a finite value between 0 and 300 GHz.")

    tx_columns, tx_rows = _array_dimensions(txs, "TX")
    rx_columns, rx_rows = _array_dimensions(rxs, "RX")
    options = solver_options
    tx_pattern = str(getattr(options, "txPattern", "tr38901"))
    tx_polarization = str(getattr(options, "txPolarization", "V"))
    rx_pattern = str(getattr(options, "rxPattern", "iso"))
    rx_polarization = str(getattr(options, "rxPolarization", "V"))
    allowed_patterns = {"iso", "dipole", "hw_dipole", "tr38901"}
    allowed_polarizations = {"V", "H", "VH", "cross"}
    if tx_pattern not in allowed_patterns or rx_pattern not in allowed_patterns:
        raise IndoorSceneActivationError("Antenna pattern must be one of iso, dipole, hw_dipole or tr38901.")
    if tx_polarization not in allowed_polarizations or rx_polarization not in allowed_polarizations:
        raise IndoorSceneActivationError("Antenna polarization must be one of V, H, VH or cross.")

    PlanarArray, Transmitter, Receiver, AntennaArray = _device_runtime_imports(active.scene)
    wavelength_m = 299_792_458.0 / (float(carrier_frequency_ghz) * 1e9)
    # Sionna PlanarArray spacings are specified in wavelength multiples; the
    # frontend preview uses 0.5λ, so these values align exactly.
    tx_array = PlanarArray(
        num_rows=tx_rows, num_cols=tx_columns,
        vertical_spacing=0.5, horizontal_spacing=0.5,
        pattern=tx_pattern, polarization=tx_polarization,
    )
    rx_array = PlanarArray(
        num_rows=rx_rows, num_cols=rx_columns,
        vertical_spacing=0.5, horizontal_spacing=0.5,
        pattern=rx_pattern, polarization=rx_polarization,
    )
    # Fail before mutating the active scene, with an actionable diagnostic,
    # rather than relying on Sionna's property setter to emit an opaque error.
    for side, array in (("TX", tx_array), ("RX", rx_array)):
        if not isinstance(array, AntennaArray):
            raise IndoorSceneActivationError(
                f"Constructed indoor {side} array is {type(array).__module__}."
                f"{type(array).__qualname__}, but active Sionna Scene requires "
                f"{AntennaArray.__module__}.{AntennaArray.__qualname__}. "
                "The runtime has inconsistent Sionna class identities; restart "
                "the backend runtime and retry scene activation."
            )

    new_tx: list[Any] = []
    new_rx: list[Any] = []
    tx_summary: list[dict[str, Any]] = []
    rx_summary: list[dict[str, Any]] = []
    for device in txs:
        instance, summary = _make_scene_device(device, kind="tx", session_id=session_id, device_class=Transmitter)
        new_tx.append(instance)
        tx_summary.append(summary)
    for device in rxs:
        instance, summary = _make_scene_device(device, kind="rx", session_id=session_id, device_class=Receiver)
        new_rx.append(instance)
        rx_summary.append(summary)

    new_names = [item.name for item in [*new_tx, *new_rx]]
    if len(new_names) != len(set(new_names)):
        raise IndoorSceneActivationError("Generated Sionna device names are not unique.")

    scene = active.scene
    current_tx = dict(getattr(scene, "transmitters", {}))
    current_rx = dict(getattr(scene, "receivers", {}))
    managed_old_names = [*active.device_names.get("tx", []), *active.device_names.get("rx", [])]
    managed_old_items = {name: current_tx.get(name) or current_rx.get(name) for name in managed_old_names}
    external_names = (set(current_tx) | set(current_rx)) - set(managed_old_names)
    collisions = sorted(set(new_names) & external_names)
    if collisions:
        raise IndoorSceneActivationError(f"Sionna scene already contains device name(s) reserved by another component: {collisions}.")

    old_tx_array = getattr(scene, "tx_array", None)
    old_rx_array = getattr(scene, "rx_array", None)
    # Scene.frequency is mi.Float on real Mitsuba variants; use the same
    # explicit Dr.Jit -> NumPy scalar conversion for the rollback snapshot.
    old_frequency = _host_scalar_float(
        getattr(scene, "frequency", 0.0), "previous scene carrier frequency"
    )
    tx_array_changed = False
    rx_array_changed = False
    try:
        for name in managed_old_names:
            scene.remove(name)
        scene.frequency = float(carrier_frequency_ghz) * 1e9
        scene.tx_array = tx_array
        tx_array_changed = True
        scene.rx_array = rx_array
        rx_array_changed = True
        # Sionna Scene.add() accepts one radio device, not a list of devices.
        # Keep the active geometry loaded and register only the current devices.
        for radio_device in (*new_tx, *new_rx):
            scene.add(radio_device)
        loaded_tx = dict(getattr(scene, "transmitters", {}))
        loaded_rx = dict(getattr(scene, "receivers", {}))
        missing_tx = sorted(name for name in [item.name for item in new_tx] if name not in loaded_tx)
        missing_rx = sorted(name for name in [item.name for item in new_rx] if name not in loaded_rx)
        if missing_tx or missing_rx:
            raise IndoorSceneActivationError(
                f"Sionna did not register all requested radio devices; missing TX={missing_tx}, RX={missing_rx}."
            )
        # Position/orientation/power are supplied directly to the Sionna
        # device constructors above. Re-reading and comparing them here adds
        # no protection to this same locked operation; the registry check is
        # sufficient to confirm that Scene.add() accepted each device.
    except Exception as exc:  # noqa: BLE001
        current_after_failure = dict(getattr(scene, "transmitters", {}))
        current_after_failure.update(dict(getattr(scene, "receivers", {})))
        for name in new_names:
            if name in current_after_failure:
                try:
                    scene.remove(name)
                except Exception:
                    pass
        rollback_errors: list[str] = []
        # Restore only properties that were successfully changed. If the
        # previous value was None, use Sionna's backing slot rather than its
        # public setter, which correctly rejects non-AntennaArray values.
        for side, changed, previous in (
            ("rx", rx_array_changed, old_rx_array),
            ("tx", tx_array_changed, old_tx_array),
        ):
            if changed:
                try:
                    _restore_scene_array(scene, side, previous)
                except Exception as rollback_exc:  # noqa: BLE001
                    rollback_errors.append(f"{side.upper()} array: {rollback_exc}")
                    logger.exception("Indoor %s array rollback failed", side.upper())
        try:
            scene.frequency = old_frequency
        except Exception as rollback_exc:  # noqa: BLE001
            rollback_errors.append(f"frequency: {rollback_exc}")
            logger.exception("Indoor frequency rollback failed")
        restore = [item for item in managed_old_items.values() if item is not None]
        for previous_item in restore:
            try:
                scene.add(previous_item)
            except Exception as rollback_exc:  # noqa: BLE001
                rollback_errors.append(f"device {getattr(previous_item, 'name', 'unknown')}: {rollback_exc}")
                logger.exception("Indoor TX/RX rollback failed for %s", getattr(previous_item, "name", "device"), rollback_exc)
        rollback_note = (
            " Rollback issues: " + "; ".join(rollback_errors)
            if rollback_errors else ""
        )
        if isinstance(exc, IndoorSceneActivationError):
            if rollback_note:
                raise IndoorSceneActivationError(f"{exc}{rollback_note}") from exc
            raise
        raise IndoorSceneActivationError(
            f"Could not apply indoor TX/RX devices to Sionna RT: {exc}{rollback_note}"
        ) from exc

    sync_summary = {
        "status": "synchronized",
        "sessionId": session_id,
        "carrierFrequencyGhz": float(carrier_frequency_ghz),
        "wavelengthMeters": wavelength_m,
        "arraySpacingMeters": 0.5 * wavelength_m,
        "txArray": {"numCols": tx_columns, "numRows": tx_rows, "pattern": tx_pattern, "polarization": tx_polarization, "spacingLambda": 0.5},
        "rxArray": {"numCols": rx_columns, "numRows": rx_rows, "pattern": rx_pattern, "polarization": rx_polarization, "spacingLambda": 0.5},
        "transmitterCount": len(new_tx),
        "receiverCount": len(new_rx),
        "transmitters": tx_summary,
        "receivers": rx_summary,
    }
    with _RUNTIME_STATE_LOCK:
        if _ACTIVE_SCENE is not active:
            # The app's main solve lock should prevent this, but keep the runtime
            # state honest if a future caller bypasses it.
            raise IndoorSceneActivationError("The active indoor scene changed during device synchronization.")
        active.device_names = {"tx": [item.name for item in new_tx], "rx": [item.name for item in new_rx]}
        active.device_sync_summary = sync_summary
        active.carrier_frequency_ghz = float(carrier_frequency_ghz)
        active.summary["carrierFrequencyGhz"] = float(carrier_frequency_ghz)
        active.summary["deviceSync"] = sync_summary
    return {"active": True, "sessionId": session_id, "summary": dict(active.summary), "deviceSync": sync_summary}


def configure_indoor_scene_transmitters_for_radiomap(
    session_id: str,
    txs: list[Any],
    carrier_frequency_ghz: float,
    solver_options: Any,
) -> dict[str, Any]:
    """Bind the current indoor TX snapshot for RadioMapSolver.

    Unlike Link/PathSolver, a radio map does not need viewport RX devices.
    The active scene geometry and radio materials are reused; only the shared
    TX array, carrier and transmitter registry are updated.
    """
    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
    if active is None or active.session_id != session_id:
        raise IndoorSceneActivationError("The requested indoor scene is not the active Sionna RT scene.")
    if not txs:
        raise IndoorSceneActivationError("Place at least one TX in the active indoor scene before computing a radio map.")
    if not np.isfinite(carrier_frequency_ghz) or not 0 < float(carrier_frequency_ghz) <= 300:
        raise IndoorSceneActivationError("Carrier frequency must be a finite value between 0 and 300 GHz.")

    _mi, _load_scene, itu_properties, _material_base, _version, _variant = _runtime_imports()
    _validate_frequency_materials(active.material_mappings, float(carrier_frequency_ghz), itu_properties)
    tx_columns, tx_rows = _array_dimensions(txs, "TX")
    options = solver_options
    tx_pattern = str(getattr(options, "txPattern", "tr38901"))
    tx_polarization = str(getattr(options, "txPolarization", "V"))
    if tx_pattern not in {"iso", "dipole", "hw_dipole", "tr38901"}:
        raise IndoorSceneActivationError("TX antenna pattern must be one of iso, dipole, hw_dipole or tr38901.")
    if tx_polarization not in {"V", "H", "VH", "cross"}:
        raise IndoorSceneActivationError("TX antenna polarization must be one of V, H, VH or cross.")

    PlanarArray, Transmitter, _Receiver, AntennaArray = _device_runtime_imports(active.scene)
    tx_array = PlanarArray(
        num_rows=tx_rows, num_cols=tx_columns,
        vertical_spacing=0.5, horizontal_spacing=0.5,
        pattern=tx_pattern, polarization=tx_polarization,
    )
    if not isinstance(tx_array, AntennaArray):
        raise IndoorSceneActivationError(
            "The indoor TX array does not belong to the active Sionna Scene's AntennaArray class. "
            "Restart the backend runtime and reactivate the indoor scene."
        )

    new_tx: list[Any] = []
    tx_summary: list[dict[str, Any]] = []
    for device in txs:
        instance, summary = _make_scene_device(
            device, kind="tx", session_id=session_id, device_class=Transmitter
        )
        new_tx.append(instance)
        tx_summary.append(summary)
    new_names = [item.name for item in new_tx]
    if len(new_names) != len(set(new_names)):
        raise IndoorSceneActivationError("Generated Sionna TX device names are not unique.")

    scene = active.scene
    current_tx = dict(getattr(scene, "transmitters", {}))
    managed_old_names = list(active.device_names.get("tx", []))
    external_names = set(current_tx) - set(managed_old_names)
    collisions = sorted(set(new_names) & external_names)
    if collisions:
        raise IndoorSceneActivationError(
            f"Sionna scene already contains TX device name(s) reserved by another component: {collisions}."
        )

    old_tx_array = getattr(scene, "tx_array", None)
    old_frequency = _host_scalar_float(
        getattr(scene, "frequency", 0.0), "previous scene carrier frequency"
    )
    tx_array_changed = False
    try:
        for name in managed_old_names:
            if name in current_tx:
                scene.remove(name)
        scene.frequency = float(carrier_frequency_ghz) * 1e9
        scene.tx_array = tx_array
        tx_array_changed = True
        for radio_device in new_tx:
            scene.add(radio_device)
        loaded_tx = dict(getattr(scene, "transmitters", {}))
        missing_tx = sorted(name for name in new_names if name not in loaded_tx)
        if missing_tx:
            raise IndoorSceneActivationError(
                f"Sionna did not register all radio-map transmitters; missing TX={missing_tx}."
            )
    except Exception as exc:  # noqa: BLE001
        current_after_failure = dict(getattr(scene, "transmitters", {}))
        for name in new_names:
            if name in current_after_failure:
                try:
                    scene.remove(name)
                except Exception:
                    pass
        rollback_errors: list[str] = []
        if tx_array_changed:
            try:
                _restore_scene_array(scene, "tx", old_tx_array)
            except Exception as rollback_exc:  # noqa: BLE001
                rollback_errors.append(f"TX array: {rollback_exc}")
                logger.exception("Indoor TX array rollback failed after radio-map binding")
        try:
            scene.frequency = old_frequency
        except Exception as rollback_exc:  # noqa: BLE001
            rollback_errors.append(f"frequency: {rollback_exc}")
            logger.exception("Indoor frequency rollback failed after radio-map binding")
        for name in managed_old_names:
            previous_item = current_tx.get(name)
            if previous_item is not None:
                try:
                    scene.add(previous_item)
                except Exception as rollback_exc:  # noqa: BLE001
                    rollback_errors.append(f"TX device {name}: {rollback_exc}")
        note = " Rollback issues: " + "; ".join(rollback_errors) if rollback_errors else ""
        if isinstance(exc, IndoorSceneActivationError):
            raise IndoorSceneActivationError(f"{exc}{note}") from exc
        raise IndoorSceneActivationError(
            f"Could not apply indoor transmitters for RadioMapSolver: {exc}{note}"
        ) from exc

    with _RUNTIME_STATE_LOCK:
        if _ACTIVE_SCENE is not active:
            raise IndoorSceneActivationError("The active indoor scene changed during radio-map TX preparation.")
        active.device_names = {
            "tx": new_names,
            "rx": list(active.device_names.get("rx", [])),
        }
        # A TX-only map setup is not a full TX/RX synchronization state. The
        # next Link solve will automatically bind both sides again.
        active.device_sync_summary = None
        active.carrier_frequency_ghz = float(carrier_frequency_ghz)
        active.summary["carrierFrequencyGhz"] = float(carrier_frequency_ghz)
        # A TX-only radio-map binding is not a full TX/RX link synchronization.
        active.summary.pop("deviceSync", None)
        active.summary["radioMapTxBinding"] = {
            "status": "ready",
            "transmitterCount": len(new_tx),
            "txArray": {
                "numCols": tx_columns, "numRows": tx_rows,
                "pattern": tx_pattern, "polarization": tx_polarization,
            },
        }
    return {
        "status": "ready",
        "sessionId": session_id,
        "carrierFrequencyGhz": float(carrier_frequency_ghz),
        "transmitterCount": len(new_tx),
        "transmitters": tx_summary,
        "runtimeNames": new_names,
    }


def solve_indoor_radiomap(session_id: str, req: Any):
    """Execute RadioMapSolver on the already activated indoor scene."""
    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
    if active is None or active.session_id != session_id:
        raise IndoorSceneActivationError("Activate the requested indoor scene in Sionna RT before computing a radio map.")
    if any(getattr(device, "sceneSessionId", None) != session_id for device in req.txs):
        raise IndoorSceneActivationError("All radio-map transmitters must belong to the active indoor scene.")

    bounds = active.summary.get("canonicalBounds") or {}
    minimum = np.asarray(bounds.get("minimum", []), dtype=np.float64)
    maximum = np.asarray(bounds.get("maximum", []), dtype=np.float64)
    if minimum.shape != (3,) or maximum.shape != (3,) or not np.isfinite(minimum).all() or not np.isfinite(maximum).all():
        raise IndoorSceneActivationError("The active indoor scene does not expose valid canonical 3D bounds for radio-map generation.")
    if np.any(maximum <= minimum):
        raise IndoorSceneActivationError("The active indoor scene has degenerate geometry bounds; a radio map cannot be generated.")
    map_z = float(minimum[2] + float(req.gridHeight))
    if map_z >= float(maximum[2]) or map_z <= float(minimum[2]):
        available = float(maximum[2] - minimum[2])
        raise IndoorSceneActivationError(
            f"Radio-map plane height {float(req.gridHeight):.2f} m is outside the indoor scene's vertical span "
            f"({available:.2f} m). Choose a height below {available:.2f} m above the scene minimum."
        )

    binding = configure_indoor_scene_transmitters_for_radiomap(
        session_id=session_id,
        txs=req.txs,
        carrier_frequency_ghz=float(req.freqGhz),
        solver_options=req.options,
    )
    from .models import ENUVector
    from .solver import solve_radiomap

    # Reuse RadioMapRequest's established analysis, caching and response model.
    # ENUVector is used here only as the common 3D coordinate carrier; values
    # are canonical indoor scene-local metres, not geodetic ENU coordinates.
    scene_txs = [
        device.model_copy(update={
            "enu": ENUVector(x=float(device.scenePosition[0]), y=float(device.scenePosition[1]), z=float(device.scenePosition[2])),
            "height": float(device.scenePosition[2]),
            "heightReference": "scene_z",
        })
        for device in req.txs
    ]
    normalized_request = req.model_copy(update={"txs": scene_txs, "buildings": []})
    return solve_radiomap(
        normalized_request,
        scene_override=active.scene,
        scene_bounds={"minimum": minimum.tolist(), "maximum": maximum.tolist()},
        map_height_z=map_z,
        device_positions={device.id: [float(v) for v in device.scenePosition] for device in req.txs},
        devices_prepared=True,
        prepared_tx_names=binding["runtimeNames"],
        scene_context_extra={
            "sceneType": "indoor",
            "indoorSessionId": session_id,
            "runtimeTxNames": list(binding["runtimeNames"]),
            "runtimeTxArray": dict(binding.get("txArray") or {}),
            "runtimeTxSummary": list(binding.get("transmitters") or []),
            "coordinateFrame": active.summary.get("coordinateFrame", {"upAxis": "+Z", "forwardAxis": "+X", "units": "m", "handedness": "right"}),
            "sceneBounds": {"minimum": minimum.tolist(), "maximum": maximum.tolist()},
        },
    )


def solve_indoor_radio_map_channel_analysis(map_id: str, req: Any) -> dict:
    """Run shared per-cell Channel Analysis on the active indoor scene.

    The radio-map cache stores the indoor session identity and TX snapshot, not
    a scene object. The active Sionna scene is resolved at request time and is
    passed into the shared Channel Analysis solver without rebuilding geometry.
    """
    from .solver import _get_cached_radio_map, solve_radio_map_channel_analysis

    cache = _get_cached_radio_map(map_id)
    context = cache.get("sceneContext") or {}
    if context.get("sceneType") != "indoor":
        raise IndoorSceneActivationError("The requested radio map is not an indoor scene.")
    session_id = context.get("indoorSessionId")
    if not session_id:
        raise IndoorSceneActivationError(
            "This indoor radio map has no saved scene-session binding. Recompute the indoor radio map."
        )

    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
        if active is None or active.session_id != session_id:
            raise IndoorSceneActivationError(
                "Activate the same indoor scene used to generate this radio map before running Channel Analysis."
            )
        expected_names = list(context.get("runtimeTxNames") or [])
        loaded_names = list(dict(getattr(active.scene, "transmitters", {})).keys())
        managed_names = list(active.device_names.get("tx", []))
        if not expected_names or loaded_names != expected_names or managed_names != expected_names:
            raise IndoorSceneActivationError(
                "The active indoor TX devices changed after this radio map was computed. "
                "Recompute the indoor radio map before running Channel Analysis."
            )
        expected_frequency = float(context.get("frequencyGhz", 0.0))
        active_frequency = getattr(active, "carrier_frequency_ghz", None)
        if (not expected_frequency or active_frequency is None
                or not np.isclose(float(active_frequency), expected_frequency, rtol=0.0, atol=1e-9)):
            raise IndoorSceneActivationError(
                "The active indoor carrier frequency changed after this radio map was computed. "
                "Recompute the indoor radio map before running Channel Analysis."
            )
        expected_array = context.get("runtimeTxArray") or {}
        current_binding = active.summary.get("radioMapTxBinding") or {}
        current_array = current_binding.get("txArray") or {}
        if expected_array and current_array and current_array != expected_array:
            raise IndoorSceneActivationError(
                "The active indoor TX antenna configuration changed after this radio map was computed. "
                "Recompute the indoor radio map before running Channel Analysis."
            )
        expected_summary = list(context.get("runtimeTxSummary") or [])
        current_sync = active.device_sync_summary or {}
        current_summary = list(current_sync.get("transmitters") or [])
        if current_summary and expected_summary and current_summary != expected_summary:
            raise IndoorSceneActivationError(
                "One or more indoor TX positions, orientations, powers or antenna settings changed after "
                "this radio map was computed. Recompute the indoor radio map before running Channel Analysis."
            )
        current_sync_array = current_sync.get("txArray") or {}
        array_fields = ("numCols", "numRows", "pattern", "polarization")
        if expected_array and current_sync_array and any(
            current_sync_array.get(key) != expected_array.get(key) for key in array_fields
        ):
            raise IndoorSceneActivationError(
                "The active indoor TX antenna array changed after this radio map was computed. "
                "Recompute the indoor radio map before running Channel Analysis."
            )
        return solve_radio_map_channel_analysis(
            map_id,
            req,
            scene_override=active.scene,
            preserve_scene_transmitters=True,
        )


def solve_indoor_mobility(session_id: str, req: Any):
    """Run the shared mobility solver over scene-local waypoints in the active scene.

    The imported geometry and already-prepared Sionna TX devices are reused.
    Only temporary RX waypoint devices are replaced during the shared batch solve;
    the viewport RX set is restored when the solve completes.
    """
    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
    if active is None or active.session_id != session_id:
        raise IndoorSceneActivationError("Activate the requested indoor scene in Sionna RT before running a mobility trajectory.")

    # Only transmitters are persistent viewport devices. The moving RX is
    # synthesized from the first path waypoint; requiring a separately placed
    # viewport RX would duplicate the path editor and block valid trajectories.
    if any(getattr(device, "sceneSessionId", None) != session_id for device in req.txs):
        raise IndoorSceneActivationError("All mobility TX devices must belong to the active indoor scene.")
    if any(getattr(device, "scenePosition", None) is None for device in req.txs):
        raise IndoorSceneActivationError("Place every mobility TX in the active indoor scene before solving.")

    bounds = active.summary.get("canonicalBounds") or {}
    minimum = np.asarray(bounds.get("minimum", []), dtype=np.float64)
    maximum = np.asarray(bounds.get("maximum", []), dtype=np.float64)
    if (minimum.shape != (3,) or maximum.shape != (3,)
            or not np.isfinite(minimum).all() or not np.isfinite(maximum).all()
            or np.any(maximum <= minimum)):
        raise IndoorSceneActivationError("The active indoor scene does not expose valid canonical 3D bounds for mobility solving.")

    # A small tolerance accommodates floating point offsets used when clicking
    # or moving a device on a wall/floor. Waypoints themselves must remain in the
    # imported room; no outdoor ENU/geodetic projection is involved.
    tolerance = 0.10
    canonical_waypoints = np.asarray(
        [[float(point.x), float(point.y), float(point.z)] for point in req.waypoints],
        dtype=np.float64,
    )
    if canonical_waypoints.ndim != 2 or canonical_waypoints.shape[1] != 3 or not np.isfinite(canonical_waypoints).all():
        raise IndoorSceneActivationError("Indoor mobility waypoints must be finite scene-local XYZ positions in metres.")
    outside = np.any(
        (canonical_waypoints < minimum[None, :] - tolerance)
        | (canonical_waypoints > maximum[None, :] + tolerance),
        axis=1,
    )
    if bool(np.any(outside)):
        index = int(np.flatnonzero(outside)[0])
        raise IndoorSceneActivationError(
            f"Indoor waypoint {index + 1} is outside the active scene bounds. "
            "Draw the trajectory on the room floor or within the imported room volume."
        )

    from .models import ENUVector
    from .solver import solve_mobility

    # Build a temporary scene-local RX template at the first waypoint. Its
    # antenna configuration comes from the selected RX model, while its pose
    # comes from the trajectory. Preserve orientation only when it belongs to
    # this same active scene; otherwise use the canonical upright orientation.
    rx_orientation = (
        req.rx.sceneOrientation
        if req.rx.sceneSessionId == session_id and req.rx.sceneOrientation is not None
        else (0.0, 0.0, 0.0, 1.0)
    )
    first_waypoint = canonical_waypoints[0]
    scene_rx_template = req.rx.model_copy(update={
        "scenePosition": tuple(float(value) for value in first_waypoint),
        "sceneNormal": (0.0, 0.0, 1.0),
        "sceneOrientation": rx_orientation,
        "sceneSurface": "floor",
        "sceneSessionId": session_id,
    })
    binding = sync_indoor_scene_devices(
        session_id=session_id,
        txs=req.txs,
        rxs=[scene_rx_template],
        carrier_frequency_ghz=float(req.freqGhz),
        solver_options=req.options,
    )

    # Reuse the existing multi-TX mobility implementation. ENUVector is only
    # the common 3D carrier here: its x/y/z values are canonical indoor metres.
    scene_txs = [
        device.model_copy(update={
            "enu": ENUVector(
                x=float(device.scenePosition[0]),
                y=float(device.scenePosition[1]),
                z=float(device.scenePosition[2]),
            ),
            "height": float(device.scenePosition[2]),
            "heightReference": "scene_z",
        })
        for device in req.txs
    ]
    scene_rx = scene_rx_template.model_copy(update={
        "enu": ENUVector(
            x=float(first_waypoint[0]),
            y=float(first_waypoint[1]),
            z=float(first_waypoint[2]),
        ),
        "height": float(first_waypoint[2]),
        "heightReference": "scene_z",
    })
    scene_waypoints = [
        ENUVector(x=float(point.x), y=float(point.y), z=float(point.z))
        for point in req.waypoints
    ]
    normalized_request = req.model_copy(update={
        "txs": scene_txs,
        "rx": scene_rx,
        "waypoints": scene_waypoints,
    })
    # sync_indoor_scene_devices returns its TX records under the nested
    # ``deviceSync`` summary (the top-level object also contains session/scene
    # metadata). Keep this adapter aligned with that public return contract.
    device_sync = binding.get("deviceSync") if isinstance(binding, dict) else None
    tx_bindings = device_sync.get("transmitters") if isinstance(device_sync, dict) else None
    if not isinstance(tx_bindings, list) or len(tx_bindings) != len(req.txs):
        raise IndoorSceneActivationError(
            "Indoor TX synchronization did not return the expected transmitter bindings. "
            "Re-run device synchronization and retry mobility."
        )
    prepared_tx_names = [str(item["runtimeName"]) for item in tx_bindings]
    return solve_mobility(
        normalized_request,
        scene_override=active.scene,
        prepared_tx_names=prepared_tx_names,
        preserve_scene_transmitters=True,
        receiver_orientation=canonical_device_orientation_to_sionna_euler(scene_rx.sceneOrientation),
    )


def _host_scalar_float(value: Any, label: str) -> float:
    """Materialize one Mitsuba/Dr.Jit scalar as a Python float.

    Vectorized Dr.Jit values (including ``mi.Float`` under CUDA/LLVM AD
    variants) deliberately do not support Python ``float(value)``. Their
    ``numpy()`` bridge performs the explicit device-to-host transfer.
    Ordinary Python/NumPy scalar values remain supported for tests and mocks.
    """
    try:
        numpy_method = getattr(value, "numpy", None)
        host_value = numpy_method() if callable(numpy_method) else value
        array = np.asarray(host_value)
        if array.size != 1:
            raise ValueError(f"expected one scalar value, received shape {array.shape}")
        result = float(array.reshape(-1)[0])
        if not np.isfinite(result):
            raise ValueError("value is not finite")
        return result
    except Exception as exc:  # noqa: BLE001 - normalize backend scalar conversion errors
        raise IndoorSceneActivationError(
            f"Could not read {label} from the active Sionna RT runtime: {exc}"
        ) from exc


def _path_array_view(value: Any, label: str, *, depth_axis: bool = False) -> np.ndarray:
    """Convert a Sionna synthetic-array tensor to device-pair axes.

    Geometry tensors may be [rx, tx, path] (or include the singleton
    synthetic antenna axes); coefficient tensors retain physical antenna
    axes. This helper only removes the singleton antenna dimensions and never
    squeezes the receiver/transmitter/path dimensions whose size can be one.
    """
    from .solver import to_numpy

    array = to_numpy(value)
    if depth_axis:
        if array.ndim == 7 and array.shape[2] == 1 and array.shape[4] == 1:
            return array[:, :, 0, :, 0, :, :]
        if array.ndim == 6 and array.shape[2] == 1 and array.shape[4] == 1:
            return array[:, :, 0, :, 0, :]
        if (label == "vertices" and array.ndim == 5) or (label != "vertices" and array.ndim == 4):
            return array
        raise IndoorSceneActivationError(
            f"Sionna returned unexpected {label} tensor shape {array.shape}; "
            "expected synthetic-array [depth, rx, tx, path] geometry."
        )
    if array.ndim == 5 and array.shape[1] == 1 and array.shape[3] == 1:
        return array[:, 0, :, 0, :]
    if array.ndim == 3:
        return array
    raise IndoorSceneActivationError(
        f"Sionna returned unexpected {label} tensor shape {array.shape}; "
        "expected synthetic-array [rx, tx, path] data."
    )


def solve_indoor_link(
    session_id: str,
    tx_id: str,
    rx_id: str,
    max_depth: int,
    solver_options: Any,
) -> dict[str, Any]:
    """Run PathSolver on the already-active indoor scene and selected pair.

    The API route applies the latest viewport devices immediately before this
    call. The scene geometry/materials are reused; only radio-device state and
    scene-level arrays are refreshed. No frontend synchronization token exists.
    """
    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
    if active is None or active.session_id != session_id:
        raise IndoorSceneActivationError("The requested indoor scene is not the active Sionna RT scene.")
    sync = active.device_sync_summary
    if not isinstance(sync, dict) or sync.get("status") != "synchronized":
        raise IndoorSceneActivationError("No indoor TX/RX devices are configured in the active scene.")
    if isinstance(max_depth, bool) or int(max_depth) != max_depth or not 0 <= int(max_depth) <= 20:
        raise IndoorSceneActivationError("PathSolver maxDepth must be an integer between 0 and 20.")

    tx_records = sync.get("transmitters", [])
    rx_records = sync.get("receivers", [])
    tx_record = next((item for item in tx_records if item.get("id") == tx_id), None)
    rx_record = next((item for item in rx_records if item.get("id") == rx_id), None)
    if tx_record is None:
        raise IndoorSceneActivationError(f"TX '{tx_id}' is not part of the current Sionna device synchronization.")
    if rx_record is None:
        raise IndoorSceneActivationError(f"RX '{rx_id}' is not part of the current Sionna device synchronization.")

    scene = active.scene
    tx_name = tx_record.get("runtimeName")
    rx_name = rx_record.get("runtimeName")
    tx_registry = getattr(scene, "transmitters", {})
    rx_registry = getattr(scene, "receivers", {})
    tx_runtime = tx_registry.get(tx_name)
    rx_runtime = rx_registry.get(rx_name)
    if tx_runtime is None or rx_runtime is None:
        raise IndoorSceneActivationError(
            "The selected TX/RX device is missing from the active Sionna scene."
        )

    # These arrays were created and assigned from this request immediately
    # before PathSolver dispatch. Do not introspect undocumented dimensions or
    # compare the scene against a second copy of the just-applied settings.
    tx_array = getattr(scene, "tx_array", None)
    rx_array = getattr(scene, "rx_array", None)
    if tx_array is None or rx_array is None:
        raise IndoorSceneActivationError("The active indoor scene has no TX/RX antenna arrays.")
    carrier_ghz = float(sync["carrierFrequencyGhz"])

    from .solver import MAX_PATHS, _beamform, _build_paths, _channel_metrics, _trace_paths, to_numpy
    # Path tensors follow Sionna's scene registries. Resolve the selected pair
    # by actual registry order so external/pre-existing devices cannot shift
    # the mapping between application IDs and tensor axes.
    tx_index = list(tx_registry).index(tx_name)
    rx_index = list(rx_registry).index(rx_name)

    started = time.perf_counter()
    try:
        # _trace_paths is the same PathSolver adapter used by the outdoor
        # solver, but it receives this already-active indoor Sionna scene.
        paths_native = _trace_paths(scene, int(max_depth), solver_options)
        native_tensor_shapes = {
            "valid": list(to_numpy(paths_native.valid).shape),
            "tau": list(to_numpy(paths_native.tau).shape),
            "doppler": list(to_numpy(paths_native.doppler).shape),
            "interactions": list(to_numpy(paths_native.interactions).shape),
            "vertices": list(to_numpy(paths_native.vertices).shape),
        }
        valid = _path_array_view(paths_native.valid, "valid").astype(bool)
        if valid.ndim != 3:
            raise IndoorSceneActivationError(f"Unexpected PathSolver valid tensor shape {valid.shape}.")
        if rx_index >= valid.shape[0] or tx_index >= valid.shape[1]:
            raise IndoorSceneActivationError(
                f"PathSolver returned {valid.shape[0]} receiver(s) × {valid.shape[1]} transmitter(s), "
                f"but the selected pair indices are RX={rx_index}, TX={tx_index}."
            )
        num_paths = int(valid.shape[2])
        vertices = _path_array_view(paths_native.vertices, "vertices", depth_axis=True)
        interactions = _path_array_view(paths_native.interactions, "interactions", depth_axis=True)
        if vertices.shape[:3] != interactions.shape[:3] or vertices.shape[1:3] != valid.shape[:2]:
            raise IndoorSceneActivationError("PathSolver returned incompatible vertices/interactions dimensions.")

        tau = _path_array_view(paths_native.tau, "tau")
        doppler = _path_array_view(paths_native.doppler, "doppler")
        theta_t = _path_array_view(paths_native.theta_t, "theta_t")
        phi_t = _path_array_view(paths_native.phi_t, "phi_t")
        theta_r = _path_array_view(paths_native.theta_r, "theta_r")
        phi_r = _path_array_view(paths_native.phi_r, "phi_r")
        a_real, a_imag = paths_native.a
        a_real_array = to_numpy(a_real)
        a_imag_array = to_numpy(a_imag)
        a_coefficients = a_real_array.astype(float) + 1j * a_imag_array.astype(float)
        tensor_shapes = {
            "normalized": {
                "valid": list(valid.shape),
                "tau": list(tau.shape),
                "doppler": list(doppler.shape),
                "interactions": list(interactions.shape),
                "vertices": list(vertices.shape),
            },
            "channelCoefficients": list(a_coefficients.shape),
        }
        if a_coefficients.ndim != 5:
            raise IndoorSceneActivationError(
                f"PathSolver returned unexpected channel coefficient shape {a_coefficients.shape}; "
                "expected [rx, rx_ant, tx, tx_ant, path]."
            )
        if a_coefficients.shape[0] != valid.shape[0] or a_coefficients.shape[2] != valid.shape[1]:
            raise IndoorSceneActivationError("PathSolver channel coefficient axes do not match the device registry.")

        tx_array_antennas = int(getattr(tx_array, "num_ant", 0))
        if tx_array_antennas < 1:
            raise IndoorSceneActivationError("The synchronized Sionna TX array reports no antenna ports.")
        pair_coefficients = a_coefficients[rx_index, :, tx_index, :, :]
        pair_power = _beamform(pair_coefficients, tx_array_antennas, num_paths)
        tx_pos = [float(value) for value in tx_record["position"]]
        rx_pos = [float(value) for value in rx_record["position"]]
        full_paths, max_doppler_hz = _build_paths(
            valid[rx_index, tx_index, :],
            tau[rx_index, tx_index, :],
            pair_power,
            doppler[rx_index, tx_index, :],
            interactions[:, rx_index, tx_index, :],
            vertices[:, rx_index, tx_index, :, :],
            theta_t[rx_index, tx_index, :],
            phi_t[rx_index, tx_index, :],
            theta_r[rx_index, tx_index, :],
            phi_r[rx_index, tx_index, :],
            tx_pos,
            rx_pos,
            float(tx_record.get("powerDbm", 30.0)),
            tx_id=tx_id,
        )
        metrics = _channel_metrics(full_paths)
    except IndoorSceneActivationError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Indoor PathSolver failed for %s -> %s", tx_id, rx_id)
        raise IndoorSceneActivationError(f"Indoor Sionna RT PathSolver execution failed: {exc}") from exc

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    execution = {
        "status": "completed" if full_paths else "completed_no_paths",
        "solver": "Sionna RT PathSolver",
        "sionnaVersion": active.summary.get("sionnaVersion", "unknown"),
        "mitsubaVariant": active.summary.get("mitsubaVariant", "unknown"),
        "carrierFrequencyGhz": carrier_ghz,
        "maxDepth": int(max_depth),
        "samplesPerSource": int(getattr(solver_options, "pathSamplesPerSource", 1_000_000)),
        "seed": int(getattr(solver_options, "pathSeed", 42)),
        "txId": tx_id,
        "txName": tx_record.get("name", tx_id),
        "rxId": rx_id,
        "rxName": rx_record.get("name", rx_id),
        "validPathCount": len(full_paths),
        "candidatePathSlots": int(num_paths),
        "returnedPathCount": min(len(full_paths), MAX_PATHS),
        "sceneObjectCount": int(active.summary.get("registeredObjectCount", len(getattr(scene, "objects", {})))),
        "radioMaterialCount": int(active.summary.get("registeredRadioMaterialCount", len(getattr(scene, "radio_materials", {})))),
        "nativeTensorShapes": native_tensor_shapes,
        "normalizedTensorShapes": tensor_shapes,
        "maxDopplerHz": float(max_doppler_hz),
        "solveTimeMs": float(elapsed_ms),
        "sceneSessionId": session_id,
    }
    return {"paths": full_paths[:MAX_PATHS], "metrics": metrics, "execution": execution}

def solve_indoor_link_matrix(
    session_id: str,
    max_depth: int,
    solver_options: Any,
) -> dict[str, Any]:
    """Solve every managed indoor Tx×Rx link from one native PathSolver result.

    Sionna's PathSolver already returns the complete receiver×transmitter
    tensor for the active scene. Reuse that one dispatch and extract each
    application pair into the same PropagationPath/ChannelMetrics models used
    by outdoor link-matrix solving. No scene geometry is rebuilt.
    """
    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
    if active is None or active.session_id != session_id:
        raise IndoorSceneActivationError("The requested indoor scene is not the active Sionna RT scene.")
    sync = active.device_sync_summary
    if not isinstance(sync, dict) or sync.get("status") != "synchronized":
        raise IndoorSceneActivationError("No indoor TX/RX devices are configured in the active scene.")
    if isinstance(max_depth, bool) or int(max_depth) != max_depth or not 0 <= int(max_depth) <= 20:
        raise IndoorSceneActivationError("PathSolver maxDepth must be an integer between 0 and 20.")

    tx_records = list(sync.get("transmitters", []))
    rx_records = list(sync.get("receivers", []))
    if not tx_records or not rx_records:
        raise IndoorSceneActivationError("At least one indoor TX and one indoor RX must be synchronized.")

    scene = active.scene
    tx_array = getattr(scene, "tx_array", None)
    rx_array = getattr(scene, "rx_array", None)
    if tx_array is None or rx_array is None:
        raise IndoorSceneActivationError("The active indoor scene has no TX/RX antenna arrays.")
    tx_registry = getattr(scene, "transmitters", {})
    rx_registry = getattr(scene, "receivers", {})
    tx_registry_order = list(tx_registry)
    rx_registry_order = list(rx_registry)
    tx_indices: dict[str, int] = {}
    rx_indices: dict[str, int] = {}
    for record in tx_records:
        runtime_name = record.get("runtimeName")
        if runtime_name not in tx_registry:
            raise IndoorSceneActivationError(
                f"Indoor TX '{record.get('id', runtime_name)}' is missing from the active Sionna scene."
            )
        tx_indices[str(record["id"])] = tx_registry_order.index(runtime_name)
    for record in rx_records:
        runtime_name = record.get("runtimeName")
        if runtime_name not in rx_registry:
            raise IndoorSceneActivationError(
                f"Indoor RX '{record.get('id', runtime_name)}' is missing from the active Sionna scene."
            )
        rx_indices[str(record["id"])] = rx_registry_order.index(runtime_name)

    from .solver import MAX_PATHS, _beamform, _build_paths, _channel_metrics, _trace_paths, to_numpy

    started = time.perf_counter()
    try:
        # Exactly one PathSolver dispatch computes all active scene TX×RX pairs.
        paths_native = _trace_paths(scene, int(max_depth), solver_options)
        native_tensor_shapes = {
            "valid": list(to_numpy(paths_native.valid).shape),
            "tau": list(to_numpy(paths_native.tau).shape),
            "doppler": list(to_numpy(paths_native.doppler).shape),
            "interactions": list(to_numpy(paths_native.interactions).shape),
            "vertices": list(to_numpy(paths_native.vertices).shape),
        }
        valid = _path_array_view(paths_native.valid, "valid").astype(bool)
        if valid.ndim != 3:
            raise IndoorSceneActivationError(f"Unexpected PathSolver valid tensor shape {valid.shape}.")
        vertices = _path_array_view(paths_native.vertices, "vertices", depth_axis=True)
        interactions = _path_array_view(paths_native.interactions, "interactions", depth_axis=True)
        if vertices.shape[:3] != interactions.shape[:3] or vertices.shape[1:3] != valid.shape[:2]:
            raise IndoorSceneActivationError("PathSolver returned incompatible vertices/interactions dimensions.")
        tau = _path_array_view(paths_native.tau, "tau")
        doppler = _path_array_view(paths_native.doppler, "doppler")
        theta_t = _path_array_view(paths_native.theta_t, "theta_t")
        phi_t = _path_array_view(paths_native.phi_t, "phi_t")
        theta_r = _path_array_view(paths_native.theta_r, "theta_r")
        phi_r = _path_array_view(paths_native.phi_r, "phi_r")
        a_real, a_imag = paths_native.a
        a_coefficients = to_numpy(a_real).astype(float) + 1j * to_numpy(a_imag).astype(float)
        if a_coefficients.ndim != 5:
            raise IndoorSceneActivationError(
                f"PathSolver returned unexpected channel coefficient shape {a_coefficients.shape}; "
                "expected [rx, rx_ant, tx, tx_ant, path]."
            )
        if (a_coefficients.shape[0] != valid.shape[0]
                or a_coefficients.shape[2] != valid.shape[1]
                or valid.shape[0] < len(rx_registry_order)
                or valid.shape[1] < len(tx_registry_order)):
            raise IndoorSceneActivationError("PathSolver channel/device axes do not match the active Sionna registries.")

        num_paths = int(valid.shape[2])
        tx_array_antennas = int(getattr(tx_array, "num_ant", 0))
        if tx_array_antennas < 1:
            raise IndoorSceneActivationError("The synchronized Sionna TX array reports no antenna ports.")
        carrier_ghz = float(sync["carrierFrequencyGhz"])
        pairs: list[dict[str, Any]] = []
        for tx_record in tx_records:
            tx_id = str(tx_record["id"])
            tx_index = tx_indices[tx_id]
            tx_pos = [float(value) for value in tx_record["position"]]
            for rx_record in rx_records:
                rx_id = str(rx_record["id"])
                rx_index = rx_indices[rx_id]
                if rx_index >= valid.shape[0] or tx_index >= valid.shape[1]:
                    raise IndoorSceneActivationError(
                        f"PathSolver returned {valid.shape[0]} receiver(s) × {valid.shape[1]} transmitter(s), "
                        f"but pair {tx_id} → {rx_id} resolves to RX={rx_index}, TX={tx_index}."
                    )
                pair_coefficients = a_coefficients[rx_index, :, tx_index, :, :]
                pair_power = _beamform(pair_coefficients, tx_array_antennas, num_paths)
                rx_pos = [float(value) for value in rx_record["position"]]
                full_paths, max_doppler_hz = _build_paths(
                    valid[rx_index, tx_index, :],
                    tau[rx_index, tx_index, :],
                    pair_power,
                    doppler[rx_index, tx_index, :],
                    interactions[:, rx_index, tx_index, :],
                    vertices[:, rx_index, tx_index, :, :],
                    theta_t[rx_index, tx_index, :],
                    phi_t[rx_index, tx_index, :],
                    theta_r[rx_index, tx_index, :],
                    phi_r[rx_index, tx_index, :],
                    tx_pos,
                    rx_pos,
                    float(tx_record.get("powerDbm", 30.0)),
                    tx_id=tx_id,
                )
                metrics = _channel_metrics(full_paths)
                execution = {
                    "status": "completed" if full_paths else "completed_no_paths",
                    "solver": "Sionna RT PathSolver",
                    "sionnaVersion": active.summary.get("sionnaVersion", "unknown"),
                    "mitsubaVariant": active.summary.get("mitsubaVariant", "unknown"),
                    "carrierFrequencyGhz": carrier_ghz,
                    "maxDepth": int(max_depth),
                    "samplesPerSource": int(getattr(solver_options, "pathSamplesPerSource", 1_000_000)),
                    "seed": int(getattr(solver_options, "pathSeed", 42)),
                    "txId": tx_id,
                    "txName": tx_record.get("name", tx_id),
                    "rxId": rx_id,
                    "rxName": rx_record.get("name", rx_id),
                    "validPathCount": len(full_paths),
                    "candidatePathSlots": num_paths,
                    "returnedPathCount": min(len(full_paths), MAX_PATHS),
                    "maxDopplerHz": float(max_doppler_hz),
                    "sceneSessionId": session_id,
                }
                pairs.append({
                    "txId": tx_id,
                    "rxId": rx_id,
                    "paths": full_paths[:MAX_PATHS],
                    "metrics": metrics,
                    "execution": execution,
                })
    except IndoorSceneActivationError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Indoor PathSolver matrix execution failed for scene %s", session_id)
        raise IndoorSceneActivationError(f"Indoor Sionna RT PathSolver matrix execution failed: {exc}") from exc

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    total_pairs = len(tx_records) * len(rx_records)
    pairs_with_paths = sum(1 for pair in pairs if pair["execution"]["validPathCount"] > 0)
    return {
        "pairs": pairs,
        "execution": {
            "status": "completed" if pairs_with_paths else "completed_no_paths",
            "solver": "Sionna RT PathSolver",
            "sionnaVersion": active.summary.get("sionnaVersion", "unknown"),
            "mitsubaVariant": active.summary.get("mitsubaVariant", "unknown"),
            "carrierFrequencyGhz": float(sync["carrierFrequencyGhz"]),
            "maxDepth": int(max_depth),
            "samplesPerSource": int(getattr(solver_options, "pathSamplesPerSource", 1_000_000)),
            "seed": int(getattr(solver_options, "pathSeed", 42)),
            "txCount": len(tx_records),
            "rxCount": len(rx_records),
            "totalPairs": total_pairs,
            "pairsWithPaths": pairs_with_paths,
            "pairsWithoutPaths": total_pairs - pairs_with_paths,
            "solveTimeMs": float(elapsed_ms),
            "sceneSessionId": session_id,
            "nativeTensorShapes": native_tensor_shapes,
        },
    }


def deactivate_indoor_scene(session_id: str | None = None) -> bool:
    """Drop the active indoor scene, optionally only when it matches a session."""
    global _ACTIVE_SCENE
    with _RUNTIME_STATE_LOCK:
        if _ACTIVE_SCENE is None:
            return False
        if session_id is not None and _ACTIVE_SCENE.session_id != session_id:
            return False
        _ACTIVE_SCENE = None
        return True


def get_active_indoor_scene() -> ActiveIndoorScene | None:
    with _RUNTIME_STATE_LOCK:
        return _ACTIVE_SCENE


def get_indoor_scene_runtime_status() -> dict[str, Any]:
    with _RUNTIME_STATE_LOCK:
        active = _ACTIVE_SCENE
        if active is None:
            return {"active": False, "sessionId": None, "summary": None}
        return {
            "active": True,
            "sessionId": active.session_id,
            "summary": dict(active.summary),
            "deviceSync": dict(active.device_sync_summary) if active.device_sync_summary else None,
        }


def _reset_indoor_scene_runtime_for_tests() -> None:
    global _ACTIVE_SCENE
    with _RUNTIME_STATE_LOCK:
        _ACTIVE_SCENE = None
