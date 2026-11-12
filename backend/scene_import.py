"""Safe, non-activating Mitsuba XML/ZIP scene importer (Phase 2).

This phase stages a source archive, inventories Mitsuba shapes/material references,
validates referenced resources, converts preview geometry to the canonical frame,
and generates a lightweight GLB for browser inspection. It does NOT load a Sionna
RT scene or mutate the active outdoor simulation.
"""
from __future__ import annotations

import io
import json
import logging
import math
import re
import shutil
import stat
import tempfile
import threading
import uuid
import zipfile
import hashlib
import copy
import os
from datetime import datetime, timezone, timedelta
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
import trimesh
from PIL import Image

from .scene_coordinates import (
    SceneCoordinateFrame,
    SceneCoordinateTransform,
    SceneBounds,
)

logger = logging.getLogger(__name__)

MAX_ARCHIVE_BYTES = 250 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
MAX_ENTRY_BYTES = 250 * 1024 * 1024
MAX_ENTRIES = 10_000
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_PREVIEW_BYTES = 300 * 1024 * 1024
MAX_PREVIEW_VERTICES = 5_000_000
MAX_PREVIEW_FACES = 10_000_000
STAGING_ROOT = Path(os.environ.get("SRTS_SCENE_CACHE_DIR", str(Path(tempfile.gettempdir()) / "sionna_rt_studio_scene_imports")))
MAX_CACHED_SCENES = 4
MAX_CACHED_BYTES = 2 * 1024 * 1024 * 1024
SCENE_SESSION_TTL = timedelta(hours=12)
SCENE_PREVIEW_CACHE_VERSION = "phase2.1-appearance-v1"

# A hint list only. This is not a claim that every hinted name is a registered
# ITU material in the installed Sionna version; registration is deferred to a
# later material/runtime phase.
KNOWN_MATERIAL_HINTS = {
    "concrete", "brick", "glass", "metal", "wood", "medium_dry_ground",
    "wet_ground", "dry_ground", "plasterboard", "asphalt", "water",
    "vegetation", "foliage", "ceiling_board", "floor_board",
}
# Visual preview colors are derived from the Mitsuba BSDF graph. A neutral
# fallback is used only when a shape has no resolvable visual material.
DEFAULT_PREVIEW_COLOR = (0.72, 0.72, 0.72, 1.0)
MAX_TEXTURE_PIXELS = 16_000_000



class SceneImportError(ValueError):
    """A user-correctable scene archive or XML validation error."""


@dataclass
class SceneImportSession:
    session_id: str
    root: Path
    manifest: dict[str, Any]
    preview_path: Path | None
    archive_sha256: str
    cache_key: str
    created_at: str
    last_accessed_at: str
    stored_bytes: int = 0


_SESSIONS: dict[str, SceneImportSession] = {}
_SESSIONS_LOCK = threading.RLock()
_IMPORT_LOCK = threading.Lock()
_SESSIONS_RESTORED = False
_SELECTED_SESSION_ID: str | None = None
_CACHE_HITS = 0


def _safe_archive_path(raw: str) -> str:
    if not raw or "\x00" in raw or "\\" in raw:
        raise SceneImportError(f"Unsafe archive path: {raw!r}")
    p = PurePosixPath(raw)
    if p.is_absolute() or any(part in ("..", "") for part in p.parts):
        raise SceneImportError(f"Unsafe archive path: {raw!r}")
    if p.parts and re.match(r"^[A-Za-z]:", p.parts[0]):
        raise SceneImportError(f"Absolute Windows path is not allowed: {raw!r}")
    normalized = p.as_posix()
    if normalized in (".", ""):
        raise SceneImportError("Empty archive path is not allowed")
    return normalized


def _resolve_resource(xml_path: str, value: str) -> str:
    value = value.strip()
    if not value:
        raise SceneImportError("XML contains an empty resource filename")
    if "\\" in value or "\x00" in value:
        raise SceneImportError(f"Unsupported resource path: {value!r}")
    p = PurePosixPath(value)
    if p.is_absolute() or any(part == ".." for part in p.parts):
        raise SceneImportError(f"XML resource path escapes the archive: {value!r}")
    parent = PurePosixPath(xml_path).parent
    candidate = (parent / p).as_posix() if str(parent) != "." else p.as_posix()
    return _safe_archive_path(candidate)


def _xml_bytes_to_root(data: bytes) -> ET.Element:
    if len(data) > MAX_XML_BYTES:
        raise SceneImportError("Mitsuba XML exceeds the 32 MB import limit")
    upper = data.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise SceneImportError("XML DTD/entity declarations are not allowed")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise SceneImportError(f"Invalid Mitsuba XML: {exc}") from exc
    if root.tag.split("}")[-1].lower() != "scene":
        raise SceneImportError("The selected XML does not have a Mitsuba <scene> root")
    return root


def _material_ref(shape: ET.Element) -> str | None:
    for child in shape.iter():
        if child.tag.split("}")[-1] == "ref" and child.attrib.get("id"):
            return child.attrib["id"]
    return None


def _shape_filename(shape: ET.Element) -> str | None:
    for child in shape.iter():
        if child.tag.split("}")[-1] == "string" and child.attrib.get("name") == "filename":
            return child.attrib.get("value")
    return None


def _material_hint(material_id: str) -> str | None:
    text = material_id.strip().casefold()
    text = re.sub(r"^(?:mat[-_])?itu[-_]", "", text)
    text = re.sub(r"[._-]\d+$", "", text)
    text = text.replace("-", "_").replace(" ", "_")
    return text if text in KNOWN_MATERIAL_HINTS else None


def _tag(element: ET.Element) -> str:
    return element.tag.split("}")[-1].lower()


def _named_child(element: ET.Element, tag: str, name: str) -> ET.Element | None:
    for child in list(element):
        if _tag(child) == tag and child.attrib.get("name") == name:
            return child
    return None


def _parse_float_value(element: ET.Element | None, default: float | None = None) -> float | None:
    if element is None:
        return default
    raw = element.attrib.get("value")
    if raw is None:
        return default
    try:
        return float(raw.strip())
    except (ValueError, TypeError):
        return default


def _parse_rgb_value(element: ET.Element | None) -> tuple[float, float, float] | None:
    if element is None:
        return None
    raw = element.attrib.get("value")
    if raw is None:
        return None
    try:
        values = [float(value) for value in raw.replace(",", " ").split()]
    except (ValueError, TypeError):
        return None
    if len(values) == 1:
        values *= 3
    if len(values) < 3 or not np.isfinite(values[:3]).all():
        return None
    # Mitsuba RGB/spectrum reflectance parameters are linear values. Keep them
    # linear in glTF baseColorFactor; Three.js performs output color conversion.
    return tuple(float(np.clip(value, 0.0, 1.0)) for value in values[:3])


def _average_image_color(image: Image.Image) -> tuple[float, float, float]:
    sample = image.convert("RGB")
    sample.thumbnail((64, 64))
    values = np.asarray(sample, dtype=np.float32) / 255.0
    # Image textures are encoded in sRGB. Decode their average to linear so it
    # can safely be used as a PBR factor if a mesh has no UV coordinates.
    average = values.mean(axis=(0, 1))
    linear = np.where(average <= 0.04045, average / 12.92, ((average + 0.055) / 1.055) ** 2.4)
    return tuple(float(value) for value in linear)


def _texture_from_node(
    node: ET.Element,
    xml_path: str,
    archive_files: dict[str, bytes],
) -> tuple[Image.Image | None, str | None, str | None]:
    texture_type = node.attrib.get("type", "").casefold()
    if texture_type != "bitmap":
        return None, None, f"Texture type '{texture_type or 'unknown'}' is not supported in the visual preview"
    filename_node = _named_child(node, "string", "filename")
    if filename_node is None:
        return None, None, "Bitmap texture has no filename"
    try:
        resource = _resolve_resource(xml_path, filename_node.attrib.get("value", ""))
        raw = archive_files[resource]
        with Image.open(io.BytesIO(raw)) as source:
            width, height = source.size
            if width <= 0 or height <= 0 or width * height > MAX_TEXTURE_PIXELS:
                return None, resource, f"Texture '{resource}' exceeds the {MAX_TEXTURE_PIXELS:,}-pixel preview limit"
            image = source.convert("RGBA")
            image.load()
        raw_node = _named_child(node, "boolean", "raw")
        raw_texture = (raw_node.attrib.get("value", "false").strip().casefold() == "true") if raw_node is not None else False
        if raw_texture:
            # Mitsuba raw bitmap values bypass sRGB decoding. glTF base-color
            # textures are sampled as sRGB, so encode these linear RGB bytes to
            # sRGB before embedding to preserve their intended linear values.
            rgba = np.asarray(image, dtype=np.float32) / 255.0
            linear_rgb = rgba[..., :3]
            srgb_rgb = np.where(
                linear_rgb <= 0.0031308,
                12.92 * linear_rgb,
                1.055 * np.power(np.maximum(linear_rgb, 0.0), 1.0 / 2.4) - 0.055,
            )
            rgba[..., :3] = np.clip(srgb_rgb, 0.0, 1.0)
            image = Image.fromarray(np.round(rgba * 255.0).astype(np.uint8), mode="RGBA")
        if any(_tag(child) == "transform" for child in list(node)):
            return image, resource, f"Bitmap texture '{resource}' has a UV transform; preview currently keeps source mesh UVs without applying that texture transform."
        return image, resource, None
    except (KeyError, OSError, ValueError, SceneImportError) as exc:
        return None, None, f"Could not load bitmap texture: {exc}"


def _find_property(node: ET.Element, tags: tuple[str, ...], names: tuple[str, ...]) -> ET.Element | None:
    for child in node.iter():
        if _tag(child) in tags and child.attrib.get("name", "") in names:
            return child
    return None


def _resolve_bsdf_visual(
    node: ET.Element | None,
    xml_path: str,
    archive_files: dict[str, bytes],
    depth: int = 0,
) -> dict[str, Any]:
    """Resolve Mitsuba BSDF nodes to an approximate glTF PBR preview descriptor.

    The preview preserves available appearance cues; it is not a physically
    equivalent Mitsuba renderer. Radio-frequency material registration remains
    a separate operation in a later phase.
    """
    if node is None:
        return {
            "baseColorLinear": DEFAULT_PREVIEW_COLOR[:3], "metallicFactor": 0.0,
            "roughnessFactor": 0.85, "source": "neutral_fallback", "texture": None,
            "warnings": ["No visual BSDF definition was found; neutral preview material used."],
        }
    if depth > 16:
        return {
            "baseColorLinear": DEFAULT_PREVIEW_COLOR[:3], "metallicFactor": 0.0,
            "roughnessFactor": 0.85, "source": "depth_limit_fallback", "texture": None,
            "warnings": ["BSDF nesting exceeds the preview recursion limit."],
        }

    kind = node.attrib.get("type", "unknown").casefold()
    warnings: list[str] = []
    bsdf_children = [child for child in list(node) if _tag(child) == "bsdf"]

    # Wrappers do not define an independent surface appearance.
    if kind in {"twosided", "bumpmap", "normalmap", "mask", "cutout", "mixturebsdf"} and bsdf_children:
        chosen = bsdf_children[0]
        result = _resolve_bsdf_visual(chosen, xml_path, archive_files, depth + 1)
        result = dict(result)
        result["source"] = f"{kind}/{result.get('source', 'nested')}"
        return result

    if kind == "blendbsdf" and len(bsdf_children) >= 2:
        # Mitsuba defines weight=0 as the first nested BSDF and weight=1 as
        # the second. Named children are ordered alphanumerically by identifier.
        ordered_children = sorted(
            enumerate(bsdf_children),
            key=lambda pair: (pair[1].attrib.get("name", f"~{pair[0]}").casefold(), pair[0]),
        )
        first_node, second_node = ordered_children[0][1], ordered_children[1][1]
        weight_node = _named_child(node, "float", "weight")
        weight = _parse_float_value(weight_node, None)
        weight_texture_node = _named_child(node, "texture", "weight")
        if weight is None and weight_texture_node is not None:
            weight_image, _weight_path, weight_warning = _texture_from_node(weight_texture_node, xml_path, archive_files)
            if weight_image is not None:
                # A single glTF PBR material cannot reproduce a spatial BSDF
                # blend mask. Use its mean linear luminance and say so.
                rgb = np.asarray(weight_image.convert("RGB"), dtype=np.float32) / 255.0
                linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
                weight = float(np.clip(linear.mean(), 0.0, 1.0))
                warnings.append("Blend BSDF weight is a bitmap; preview uses its spatial mean, not the original per-pixel BSDF blend.")
            else:
                weight = 0.5
                if weight_warning:
                    warnings.append(weight_warning)
                warnings.append("Blend BSDF bitmap weight could not be evaluated; equal blend used for preview.")
        if weight is None:
            weight = 0.5
        weight = float(np.clip(weight, 0.0, 1.0))
        first = _resolve_bsdf_visual(first_node, xml_path, archive_files, depth + 1)
        second = _resolve_bsdf_visual(second_node, xml_path, archive_files, depth + 1)
        color = tuple(
            (1.0 - weight) * float(first["baseColorLinear"][i]) + weight * float(second["baseColorLinear"][i])
            for i in range(3)
        )
        texture = second.get("texture") if weight >= 0.5 else first.get("texture")
        if first.get("texture") and second.get("texture") and first["texture"] != second["texture"]:
            warnings.append("Blend BSDF combines different textures; preview uses the dominant component only.")
        warnings.extend(first.get("warnings", []))
        warnings.extend(second.get("warnings", []))
        return {
            "baseColorLinear": color,
            "metallicFactor": float((1.0 - weight) * first.get("metallicFactor", 0.0) + weight * second.get("metallicFactor", 0.0)),
            "roughnessFactor": float((1.0 - weight) * first.get("roughnessFactor", 0.6) + weight * second.get("roughnessFactor", 0.6)),
            "source": "blendbsdf_approximation",
            "texture": texture,
            "texturePath": second.get("texturePath") if texture == second.get("texture") else first.get("texturePath"),
            "warnings": warnings,
        }

    if kind in {"diffuse", "roughdiffuse", "plastic", "roughplastic", "principled"}:
        reflectance = _find_property(node, ("rgb", "spectrum", "texture"), ("reflectance", "diffuse_reflectance", "base_color", "baseColor"))
        texture = None
        texture_path = None
        if reflectance is not None and _tag(reflectance) == "texture":
            texture, texture_path, texture_warning = _texture_from_node(reflectance, xml_path, archive_files)
            if texture_warning:
                warnings.append(texture_warning)
            base = _average_image_color(texture) if texture is not None else None
        else:
            base = _parse_rgb_value(reflectance)
        if base is None:
            base = (0.72, 0.72, 0.72)
            warnings.append(f"BSDF '{kind}' has no supported RGB/bitmap reflectance; neutral fallback used.")
        roughness = _parse_float_value(_find_property(node, ("float",), ("roughness", "alpha")), 0.8)
        if roughness is None:
            roughness = 0.8
        # Mitsuba microfacet alpha is not identical to glTF perceptual
        # roughness; sqrt(alpha) provides a stable visual approximation.
        if _find_property(node, ("float",), ("alpha",)) is not None:
            roughness = math.sqrt(max(0.0, roughness))
        metallic = _parse_float_value(_find_property(node, ("float",), ("metallic",)), 0.0) or 0.0
        return {
            "baseColorLinear": base, "metallicFactor": float(np.clip(metallic, 0.0, 1.0)),
            "roughnessFactor": float(np.clip(roughness, 0.04, 1.0)),
            "source": "bitmap_reflectance" if texture is not None else "rgb_reflectance" if reflectance is not None else "neutral_fallback",
            "texture": texture, "texturePath": texture_path, "warnings": warnings,
        }

    if kind in {"roughconductor", "conductor", "metal"}:
        specular = _find_property(node, ("rgb", "spectrum", "texture"), ("specular_reflectance", "specularReflectance"))
        texture = None
        texture_path = None
        if specular is not None and _tag(specular) == "texture":
            texture, texture_path, texture_warning = _texture_from_node(specular, xml_path, archive_files)
            if texture_warning:
                warnings.append(texture_warning)
            base = _average_image_color(texture) if texture is not None else None
        else:
            base = _parse_rgb_value(specular)
        if base is None:
            base = (0.78, 0.78, 0.78)
            warnings.append(f"BSDF '{kind}' has no explicit specular reflectance; neutral conductor preview used.")
        alpha = _parse_float_value(_find_property(node, ("float",), ("alpha",)), 0.04)
        roughness = math.sqrt(max(0.0, alpha or 0.04))
        return {
            "baseColorLinear": base, "metallicFactor": 1.0,
            "roughnessFactor": float(np.clip(roughness, 0.04, 1.0)),
            "source": "specular_reflectance", "texture": texture,
            "texturePath": texture_path, "warnings": warnings,
        }

    if kind in {"dielectric", "roughdielectric", "thindielectric"}:
        transmittance = _find_property(node, ("rgb", "spectrum", "texture"), ("specular_transmittance", "transmittance"))
        reflectance = _find_property(node, ("rgb", "spectrum", "texture"), ("specular_reflectance", "reflectance"))
        color = _parse_rgb_value(transmittance) or _parse_rgb_value(reflectance) or (0.82, 0.9, 0.98)
        alpha = _parse_float_value(_find_property(node, ("float",), ("alpha",)), 0.02)
        return {
            "baseColorLinear": color, "metallicFactor": 0.0,
            "roughnessFactor": float(np.clip(math.sqrt(max(0.0, alpha or 0.02)), 0.04, 1.0)),
            "source": "dielectric_approximation", "texture": None, "warnings": warnings,
        }

    if bsdf_children:
        result = _resolve_bsdf_visual(bsdf_children[0], xml_path, archive_files, depth + 1)
        result = dict(result)
        result["source"] = f"{kind}/{result.get('source', 'nested')}"
        result.setdefault("warnings", []).append(f"BSDF wrapper '{kind}' was approximated using its first nested BSDF.")
        return result

    return {
        "baseColorLinear": DEFAULT_PREVIEW_COLOR[:3], "metallicFactor": 0.0,
        "roughnessFactor": 0.85, "source": "unsupported_bsdf_fallback", "texture": None,
        "warnings": [f"BSDF type '{kind}' is not yet mapped to a visual preview; neutral fallback used."],
    }


def _mesh_has_explicit_vertex_colors(mesh: trimesh.Trimesh) -> bool:
    raw = mesh.metadata.get("_ply_raw", {}) if isinstance(mesh.metadata, dict) else {}
    vertex_properties = raw.get("vertex", {}).get("properties", {}) if isinstance(raw, dict) else {}
    face_properties = raw.get("face", {}).get("properties", {}) if isinstance(raw, dict) else {}
    color_names = {"red", "green", "blue", "alpha", "r", "g", "b"}
    return bool(color_names.intersection(vertex_properties) or color_names.intersection(face_properties))


def _apply_preview_material(
    mesh: trimesh.Trimesh,
    descriptor: dict[str, Any],
    material_name: str,
) -> tuple[bool, str | None]:
    """Assign a GLB-compatible PBR material while retaining existing UVs/colors."""
    from trimesh.visual.texture import TextureVisuals

    uv = getattr(mesh.visual, "uv", None)
    has_vertex_colors = _mesh_has_explicit_vertex_colors(mesh)
    image = descriptor.get("texture")
    if has_vertex_colors:
        # Keep the source visual object intact: replacing it with TextureVisuals
        # would discard explicit PLY vertex/face colors. Source colors take
        # precedence over a material tint in this diagnostic preview.
        warning = None
        if image is not None:
            warning = f"Material '{material_name}' has a bitmap texture, but explicit mesh vertex colors take precedence in the preview."
        return False, warning
    if image is not None and uv is None:
        warning = f"Material '{material_name}' has a bitmap texture but this mesh has no UV coordinates; average texture color used."
        color = _average_image_color(image)
        image = None
    elif image is not None:
        # In glTF, baseColorTexture is already the surface color. A factor of
        # the texture's average would multiply the image by itself and darken it.
        warning = None
        color = (1.0, 1.0, 1.0)
    else:
        warning = None
        color = descriptor.get("baseColorLinear", DEFAULT_PREVIEW_COLOR[:3])

    material = trimesh.visual.material.PBRMaterial(
        name=material_name,
        baseColorFactor=tuple(float(np.clip(v, 0.0, 1.0)) for v in (*color, 1.0)),
        metallicFactor=float(np.clip(descriptor.get("metallicFactor", 0.0), 0.0, 1.0)),
        roughnessFactor=float(np.clip(descriptor.get("roughnessFactor", 0.8), 0.04, 1.0)),
        baseColorTexture=image,
        doubleSided=True,
    )
    mesh.visual = TextureVisuals(uv=uv, material=material)
    return bool(image is not None), warning


def _matrix_for_shape(shape: ET.Element) -> tuple[np.ndarray, list[str]]:
    """Read common Mitsuba to_world transforms; return 4x4 and warnings."""
    warnings: list[str] = []
    matrix = np.eye(4, dtype=np.float64)
    transform = None
    for child in list(shape):
        if child.tag.split("}")[-1] == "transform" and child.attrib.get("name") in (None, "to_world"):
            transform = child
            break
    if transform is None:
        return matrix, warnings

    for op in list(transform):
        tag = op.tag.split("}")[-1]
        attrs = op.attrib
        step = np.eye(4, dtype=np.float64)
        try:
            if tag == "matrix":
                values = [float(v) for v in attrs.get("value", "").replace(",", " ").split()]
                if len(values) != 16:
                    raise ValueError("matrix needs 16 values")
                step = np.asarray(values, dtype=np.float64).reshape((4, 4))
            elif tag == "translate":
                step[:3, 3] = [float(attrs.get(axis, "0")) for axis in ("x", "y", "z")]
            elif tag == "scale":
                step[0, 0] = float(attrs.get("x", attrs.get("value", "1")))
                step[1, 1] = float(attrs.get("y", attrs.get("value", "1")))
                step[2, 2] = float(attrs.get("z", attrs.get("value", "1")))
            elif tag == "rotate":
                axis = np.asarray([float(attrs.get(a, "0")) for a in ("x", "y", "z")])
                norm = float(np.linalg.norm(axis))
                if norm <= 1e-12:
                    raise ValueError("rotate axis is zero")
                axis /= norm
                angle = math.radians(float(attrs.get("angle", "0")))
                x, y, z = axis
                c, s, t = math.cos(angle), math.sin(angle), 1 - math.cos(angle)
                step[:3, :3] = [
                    [t*x*x+c, t*x*y-s*z, t*x*z+s*y],
                    [t*x*y+s*z, t*y*y+c, t*y*z-s*x],
                    [t*x*z-s*y, t*y*z+s*x, t*z*z+c],
                ]
            else:
                warnings.append(f"Unsupported Mitsuba transform operation '{tag}' on shape '{shape.attrib.get('id', '')}'")
                continue
            # Mitsuba transform XML composes operations in document order.
            matrix = step @ matrix
        except (ValueError, TypeError) as exc:
            warnings.append(f"Could not parse transform '{tag}' on shape '{shape.attrib.get('id', '')}': {exc}")
    if not np.isfinite(matrix).all():
        raise SceneImportError(f"Shape {shape.attrib.get('id', '')!r} has a non-finite transform")
    return matrix, warnings


def _load_preview_mesh(data: bytes, filename: str) -> trimesh.Trimesh:
    extension = PurePosixPath(filename).suffix.casefold().lstrip(".")
    if extension not in {"ply", "obj", "stl", "off"}:
        raise SceneImportError(
            f"Preview mesh format {extension or '(no extension)'!r} is not supported yet for {filename!r}; "
            "supported formats are PLY, OBJ, STL and OFF"
        )
    try:
        loaded = trimesh.load(io.BytesIO(data), file_type=extension, process=False, force="mesh")
        if not isinstance(loaded, trimesh.Trimesh):
            raise TypeError(f"{extension.upper()} did not produce a single mesh")
        if len(loaded.vertices) == 0 or len(loaded.faces) == 0:
            raise ValueError("mesh has no vertices or faces")
        if not np.isfinite(np.asarray(loaded.vertices)).all():
            raise ValueError("mesh has non-finite vertices")
        return loaded
    except Exception as exc:  # noqa: BLE001 - expose a compact resource-specific error
        raise SceneImportError(f"Could not read mesh resource {filename!r}: {exc}") from exc


def _parse_scene_manifest(
    xml_path: str,
    xml_bytes: bytes,
    archive_files: dict[str, bytes],
    frame: SceneCoordinateFrame,
    session_id: str,
    archive_name: str,
) -> tuple[dict[str, Any], bytes | None]:
    root = _xml_bytes_to_root(xml_bytes)
    transformer = SceneCoordinateTransform(frame)
    materials_by_id: dict[str, dict[str, Any]] = {}
    visual_descriptors: dict[str, dict[str, Any]] = {}
    for child in list(root):
        if child.tag.split("}")[-1] != "bsdf":
            continue
        material_id = child.attrib.get("id")
        if not material_id:
            continue
        visual = _resolve_bsdf_visual(child, xml_path, archive_files)
        visual_descriptors[material_id] = visual
        materials_by_id[material_id] = {
            "id": material_id,
            "name": child.attrib.get("name") or material_id,
            "bsdfType": child.attrib.get("type", "unknown"),
            "nameHint": _material_hint(material_id),
            "shapeCount": 0,
            "isReferenced": False,
            "previewColorLinear": list(visual.get("baseColorLinear", DEFAULT_PREVIEW_COLOR[:3])),
            "previewMetallic": visual.get("metallicFactor", 0.0),
            "previewRoughness": visual.get("roughnessFactor", 0.8),
            "previewSource": visual.get("source", "neutral_fallback"),
            "previewTexturePath": visual.get("texturePath"),
            "previewWarnings": visual.get("warnings", []),
        }

    shape_nodes = [el for el in root.iter() if el.tag.split("}")[-1] == "shape"]
    resource_refs: set[str] = set()
    missing: list[str] = []
    include_refs: list[str] = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag == "include" and el.attrib.get("filename"):
            include_refs.append(_resolve_resource(xml_path, el.attrib["filename"]))
        if tag == "string" and el.attrib.get("name") == "filename" and el.attrib.get("value"):
            resource_refs.add(_resolve_resource(xml_path, el.attrib["value"]))

    for resource in sorted(resource_refs | set(include_refs)):
        if resource not in archive_files:
            missing.append(resource)
    if missing:
        sample = ", ".join(missing[:8])
        suffix = " …" if len(missing) > 8 else ""
        raise SceneImportError(f"Scene references {len(missing)} missing archive resource(s): {sample}{suffix}")

    objects: list[dict[str, Any]] = []
    warnings: list[str] = []
    if include_refs:
        warnings.append(
            f"The XML references {len(include_refs)} included XML fragment(s). Their files were validated and staged, "
            "but nested fragment objects are not expanded in the Phase 2 inventory yet."
        )
    geometry = trimesh.Scene()
    aggregate_min = np.array([np.inf, np.inf, np.inf], dtype=np.float64)
    aggregate_max = np.array([-np.inf, -np.inf, -np.inf], dtype=np.float64)
    total_vertices = 0
    total_faces = 0
    unsupported_shapes: dict[str, int] = {}

    for index, shape in enumerate(shape_nodes):
        shape_type = shape.attrib.get("type", "unknown")
        object_id = shape.attrib.get("id") or f"shape_{index + 1}"
        object_name = shape.attrib.get("name") or object_id
        filename_value = _shape_filename(shape)
        mat_ref = _material_ref(shape)
        if mat_ref in materials_by_id:
            materials_by_id[mat_ref]["shapeCount"] += 1
            materials_by_id[mat_ref]["isReferenced"] = True
        elif mat_ref:
            warnings.append(f"Shape {object_id!r} references undefined BSDF id {mat_ref!r}")
        else:
            warnings.append(f"Shape {object_id!r} has no explicit BSDF reference")
        supported_shape_extensions = {"ply", "obj", "stl", "off"}
        if shape_type.casefold() not in supported_shape_extensions:
            unsupported_shapes[shape_type] = unsupported_shapes.get(shape_type, 0) + 1
            objects.append({
                "id": object_id, "name": object_name, "shapeType": shape_type,
                "fileName": filename_value, "materialId": mat_ref,
                "previewStatus": "unsupported_shape_type",
                "vertexCount": None, "faceCount": None,
            })
            continue
        if not filename_value:
            warnings.append(f"Mesh shape {object_id!r} has no filename property")
            continue
        resource = _resolve_resource(xml_path, filename_value)
        mesh = _load_preview_mesh(archive_files[resource], resource)
        source_matrix, transform_warnings = _matrix_for_shape(shape)
        warnings.extend(transform_warnings)
        vertices = np.asarray(mesh.vertices, dtype=np.float64)
        homogeneous = np.column_stack((vertices, np.ones(len(vertices), dtype=np.float64)))
        transformed_source = (source_matrix @ homogeneous.T).T[:, :3]
        canonical = np.asarray([transformer.point_to_canonical(row) for row in transformed_source])
        mesh.vertices = canonical
        combined_determinant = transformer.determinant * float(np.linalg.det(source_matrix[:3, :3]))
        if combined_determinant < 0.0:
            mesh.faces = np.asarray(mesh.faces)[:, [0, 2, 1]]
        # Recompute normals from the transformed geometry so source-frame
        # normals are not left in the original basis after axis/unit changes.
        mesh.fix_normals(multibody=True)
        if mat_ref in materials_by_id:
            descriptor = visual_descriptors.get(mat_ref) or _resolve_bsdf_visual(None, xml_path, archive_files)
            texture_applied, texture_warning = _apply_preview_material(mesh, descriptor, mat_ref)
            if texture_warning:
                warnings.append(texture_warning)
            if texture_applied:
                materials_by_id[mat_ref]["previewTextureApplied"] = True
            elif descriptor.get("texturePath"):
                materials_by_id[mat_ref]["previewTextureApplied"] = False
        elif mat_ref:
            # Undefined XML references are already reported above. Preserve
            # explicit mesh vertex colors if present; otherwise use neutral grey.
            _apply_preview_material(mesh, _resolve_bsdf_visual(None, xml_path, archive_files), mat_ref)
        else:
            # Keep any explicitly embedded PLY/OBJ visual data. Only assign a
            # neutral PBR material when the source mesh has no visual payload.
            if not _mesh_has_explicit_vertex_colors(mesh) and getattr(mesh.visual, "uv", None) is None:
                _apply_preview_material(mesh, _resolve_bsdf_visual(None, xml_path, archive_files), object_id)
        mesh_name = f"{object_id}::{object_name}"
        geometry.add_geometry(mesh, geom_name=mesh_name, node_name=object_id)
        bounds = np.asarray(mesh.bounds, dtype=np.float64)
        aggregate_min = np.minimum(aggregate_min, bounds[0])
        aggregate_max = np.maximum(aggregate_max, bounds[1])
        vertices_count, faces_count = len(mesh.vertices), len(mesh.faces)
        total_vertices += vertices_count
        total_faces += faces_count
        if total_vertices > MAX_PREVIEW_VERTICES or total_faces > MAX_PREVIEW_FACES:
            raise SceneImportError(
                f"Scene preview exceeds the geometry budget ({MAX_PREVIEW_VERTICES:,} vertices / "
                f"{MAX_PREVIEW_FACES:,} faces). Use a decimated preview export."
            )
        objects.append({
            "id": object_id,
            "name": object_name,
            "shapeType": shape_type,
            "fileName": filename_value,
            "resolvedFile": resource,
            "materialId": mat_ref,
            "previewStatus": "ready",
            "vertexCount": vertices_count,
            "faceCount": faces_count,
            "canonicalBounds": {
                "minimum": bounds[0].round(6).tolist(),
                "maximum": bounds[1].round(6).tolist(),
            },
        })

    preview_bytes: bytes | None = None
    preview_error: str | None = None
    if len(geometry.geometry) > 0:
        try:
            exported = geometry.export(file_type="glb")
            preview_bytes = bytes(exported)
            if len(preview_bytes) > MAX_PREVIEW_BYTES:
                preview_bytes = None
                preview_error = "Generated GLB preview exceeds the 300 MB preview limit"
        except Exception as exc:  # noqa: BLE001
            preview_error = f"Could not generate GLB preview: {exc}"
    else:
        preview_error = "No supported PLY shapes were found for geometry preview"
    if preview_error:
        warnings.append(preview_error)

    materials = sorted(materials_by_id.values(), key=lambda x: x["id"].casefold())
    bounds_json = None
    if np.isfinite(aggregate_min).all() and np.isfinite(aggregate_max).all():
        bounds_json = {"minimum": aggregate_min.round(6).tolist(), "maximum": aggregate_max.round(6).tolist()}

    manifest = {
        "sessionId": session_id,
        "archiveName": archive_name,
        "xmlPath": xml_path,
        "sceneVersion": root.attrib.get("version"),
        "status": "preview_ready" if preview_bytes else "inventory_ready",
        "activation": "not_loaded_into_sionna",
        "coordinateFrame": frame.model_dump(mode="json"),
        "canonicalFrame": {
            "upAxis": "+Z", "forwardAxis": "+X", "units": "m", "handedness": "right"
        },
        "coordinateTransform": {
            "matrix": [list(row) for row in transformer.matrix],
            "scaleToMeters": transformer.scale_to_meters,
            "determinant": transformer.determinant,
            "requiresWindingFlip": transformer.requires_winding_flip,
        },
        "stats": {
            "shapeCount": len(shape_nodes),
            "previewedShapeCount": sum(1 for item in objects if item["previewStatus"] == "ready"),
            "unsupportedShapeCount": sum(unsupported_shapes.values()),
            "materialCount": len(materials),
            "referencedMaterialCount": sum(1 for item in materials if item["isReferenced"]),
            "resourceCount": len(resource_refs | set(include_refs)),
            "textureCount": sum(1 for ref in resource_refs if Path(ref).suffix.casefold() in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr"}),
            "materialsWithTexturePreview": sum(1 for item in materials_by_id.values() if item.get("previewTextureApplied")),
            "totalVertices": total_vertices,
            "totalFaces": total_faces,
        },
        "canonicalBounds": bounds_json,
        "materials": materials,
        "objects": objects,
        "resources": sorted(resource_refs | set(include_refs)),
        "unsupportedShapeTypes": unsupported_shapes,
        "warnings": warnings,
        "previewUrl": f"/api/scene/import/{session_id}/preview.glb" if preview_bytes else None,
    }
    return manifest, preview_bytes


def _create_scene_import_preview_uncached(archive_bytes: bytes, archive_name: str, frame: SceneCoordinateFrame, archive_sha256: str, cache_key: str) -> dict[str, Any]:
    """Validate, stage, inventory and create a coordinate-normalized GLB preview."""
    if not archive_bytes:
        raise SceneImportError("Uploaded scene archive is empty")
    if len(archive_bytes) > MAX_ARCHIVE_BYTES:
        raise SceneImportError("Scene archive exceeds the 250 MB upload limit")
    if not zipfile.is_zipfile(io.BytesIO(archive_bytes)):
        raise SceneImportError("Upload a ZIP archive containing one Mitsuba XML scene and its referenced resources")

    try:
        with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ENTRIES:
                raise SceneImportError(f"Archive contains more than {MAX_ENTRIES} entries")
            files: dict[str, bytes] = {}
            total_uncompressed = 0
            seen: set[str] = set()
            for info in infos:
                if info.is_dir():
                    continue
                name = _safe_archive_path(info.filename)
                if name in seen:
                    raise SceneImportError(f"Archive contains duplicate entry {name!r}")
                seen.add(name)
                unix_mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(unix_mode):
                    raise SceneImportError(f"Symbolic links are not allowed in scene archives: {name!r}")
                if info.flag_bits & 0x1:
                    raise SceneImportError(f"Encrypted archive entry is not supported: {name!r}")
                if info.file_size > MAX_ENTRY_BYTES:
                    raise SceneImportError(f"Archive entry exceeds the 250 MB per-file limit: {name!r}")
                total_uncompressed += info.file_size
                if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                    raise SceneImportError("Archive expands beyond the 1 GB uncompressed limit")
                try:
                    files[name] = archive.read(info)
                except Exception as exc:  # noqa: BLE001
                    raise SceneImportError(f"Could not read archive entry {name!r}: {exc}") from exc
    except zipfile.BadZipFile as exc:
        raise SceneImportError(f"Invalid ZIP archive: {exc}") from exc

    xml_candidates: list[tuple[str, bytes, ET.Element]] = []
    for name, data in files.items():
        if PurePosixPath(name).suffix.casefold() != ".xml":
            continue
        try:
            root = _xml_bytes_to_root(data)
        except SceneImportError as exc:
            if "DTD/entity" in str(exc):
                raise
            continue
        xml_candidates.append((name, data, root))
    if not xml_candidates:
        raise SceneImportError("No valid Mitsuba XML file with a <scene> root was found in the ZIP")
    if len(xml_candidates) > 1:
        candidates = ", ".join(item[0] for item in xml_candidates[:6])
        raise SceneImportError(f"ZIP contains multiple Mitsuba scene XML files; provide one scene per ZIP: {candidates}")

    xml_path, xml_bytes, _ = xml_candidates[0]
    session_id = uuid.uuid4().hex
    manifest, preview_bytes = _parse_scene_manifest(
        xml_path, xml_bytes, files, frame, session_id, Path(archive_name).name
    )

    now = _utc_now()
    manifest["archiveSha256"] = archive_sha256
    manifest["sceneManager"] = {
        "state": "staged",
        "selected": False,
        "createdAt": now,
        "lastAccessedAt": now,
        "cacheKey": cache_key,
    }

    STAGING_ROOT.mkdir(parents=True, exist_ok=True)
    root_dir = STAGING_ROOT / session_id
    temp_dir = STAGING_ROOT / f".staging-{session_id}"
    try:
        temp_dir.mkdir(parents=True, exist_ok=False)
        for name, data in files.items():
            target = temp_dir.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        preview_path = temp_dir / "__preview__" / "scene_preview.glb" if preview_bytes else None
        if preview_path:
            preview_path.parent.mkdir(parents=True, exist_ok=True)
            preview_path.write_bytes(preview_bytes)
        _write_json_atomic(temp_dir / "__scene_import_manifest__.json", manifest)
        os.replace(temp_dir, root_dir)
        preview_path = root_dir / "__preview__" / "scene_preview.glb" if preview_bytes else None
        session = SceneImportSession(
            session_id=session_id,
            root=root_dir,
            manifest=manifest,
            preview_path=preview_path,
            archive_sha256=archive_sha256,
            cache_key=cache_key,
            created_at=now,
            last_accessed_at=now,
            stored_bytes=_directory_size(root_dir),
        )
        with _SESSIONS_LOCK:
            _SESSIONS[session_id] = session
            _persist_manager_state_locked()
            _prune_sessions_locked()
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        shutil.rmtree(root_dir, ignore_errors=True)
        raise
    return copy.deepcopy(session.manifest)



def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _parse_timestamp(value: str | None) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return datetime.fromtimestamp(0, tz=timezone.utc)


def _directory_size(path: Path) -> int:
    total = 0
    try:
        for item in path.rglob("*"):
            if item.is_file():
                try:
                    total += item.stat().st_size
                except OSError:
                    continue
    except OSError:
        return total
    return total


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    temp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(temp_path, path)


def _session_manifest_path(root: Path) -> Path:
    return root / "__scene_import_manifest__.json"


def _persist_session_locked(session: SceneImportSession) -> None:
    _write_json_atomic(_session_manifest_path(session.root), session.manifest)


def _persist_manager_state_locked() -> None:
    _write_json_atomic(STAGING_ROOT / "__manager_state__.json", {
        "version": 1,
        "selectedSessionId": _SELECTED_SESSION_ID,
        "cacheHits": _CACHE_HITS,
        "updatedAt": _utc_now(),
    })


def _session_is_valid_on_disk(session: SceneImportSession) -> bool:
    if not session.root.is_dir():
        return False
    xml_path = session.manifest.get("xmlPath")
    if not isinstance(xml_path, str):
        return False
    try:
        safe_xml = _safe_archive_path(xml_path)
    except SceneImportError:
        return False
    if not session.root.joinpath(*PurePosixPath(safe_xml).parts).is_file():
        return False
    for resource in session.manifest.get("resources", []):
        try:
            safe_resource = _safe_archive_path(str(resource))
        except SceneImportError:
            return False
        if not session.root.joinpath(*PurePosixPath(safe_resource).parts).is_file():
            return False
    expected_preview = session.root / "__preview__" / "scene_preview.glb"
    if expected_preview.is_file():
        session.preview_path = expected_preview
    else:
        session.preview_path = None
        session.manifest["previewUrl"] = None
        if session.manifest.get("status") == "preview_ready":
            session.manifest["status"] = "inventory_ready"
    return True


def _ensure_sessions_restored_locked() -> None:
    """Rehydrate the session registry from staged files after a backend restart.

    The cache survives backend-process restarts as long as STAGING_ROOT remains
    available. It is intentionally runtime-local; Colab runtime resets still
    remove ephemeral storage unless the operator configures a persistent cache dir.
    """
    global _SESSIONS_RESTORED, _SELECTED_SESSION_ID, _CACHE_HITS
    if _SESSIONS_RESTORED:
        return
    _SESSIONS_RESTORED = True
    if not STAGING_ROOT.is_dir():
        return
    for root in STAGING_ROOT.iterdir():
        if not root.is_dir():
            continue
        if root.name.startswith(".staging-"):
            shutil.rmtree(root, ignore_errors=True)
            continue
        if root.name.startswith("."):
            continue
        manifest_path = _session_manifest_path(root)
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            session_id = str(manifest.get("sessionId", ""))
            manager_meta = manifest.get("sceneManager") or {}
            if not session_id or session_id != root.name:
                continue
            preview_path = root / "__preview__" / "scene_preview.glb"
            session = SceneImportSession(
                session_id=session_id,
                root=root,
                manifest=manifest,
                preview_path=preview_path if preview_path.is_file() else None,
                archive_sha256=str(manifest.get("archiveSha256", "")),
                cache_key=str(manager_meta.get("cacheKey", "")),
                created_at=str(manager_meta.get("createdAt", _utc_now())),
                last_accessed_at=str(manager_meta.get("lastAccessedAt", manager_meta.get("createdAt", _utc_now()))),
                stored_bytes=_directory_size(root),
            )
            if _session_is_valid_on_disk(session):
                _SESSIONS[session_id] = session
            else:
                shutil.rmtree(root, ignore_errors=True)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            logger.warning("Skipping invalid persisted scene-import session at %s", root)

    state_path = STAGING_ROOT / "__manager_state__.json"
    if state_path.is_file():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            candidate = state.get("selectedSessionId")
            _SELECTED_SESSION_ID = candidate if candidate in _SESSIONS else None
            _CACHE_HITS = max(0, int(state.get("cacheHits", 0)))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            _SELECTED_SESSION_ID = None
    if _SELECTED_SESSION_ID is None:
        for session in _SESSIONS.values():
            if (session.manifest.get("sceneManager") or {}).get("selected"):
                _SELECTED_SESSION_ID = session.session_id
                break
    _sync_selection_metadata_locked()
    _prune_sessions_locked()


def _sync_selection_metadata_locked() -> None:
    for session in _SESSIONS.values():
        metadata = session.manifest.setdefault("sceneManager", {})
        selected = session.session_id == _SELECTED_SESSION_ID
        metadata["selected"] = selected
        metadata["state"] = "selected" if selected else "staged"
        _persist_session_locked(session)


def _prune_sessions_locked() -> None:
    """Apply TTL/LRU limits without evicting the currently selected scene."""
    global _SELECTED_SESSION_ID
    now = datetime.now(timezone.utc)
    entries = list(_SESSIONS.values())
    for session in entries:
        invalid = not _session_is_valid_on_disk(session)
        age = now - _parse_timestamp(session.last_accessed_at)
        expired = age > SCENE_SESSION_TTL and session.session_id != _SELECTED_SESSION_ID
        if invalid or expired:
            _SESSIONS.pop(session.session_id, None)
            if _SELECTED_SESSION_ID == session.session_id:
                _SELECTED_SESSION_ID = None
            shutil.rmtree(session.root, ignore_errors=True)
    entries = sorted(
        _SESSIONS.values(),
        key=lambda item: _parse_timestamp(item.last_accessed_at),
        reverse=True,
    )
    total_bytes = sum(item.stored_bytes for item in entries)
    count = len(entries)
    for session in reversed(entries):
        if count <= MAX_CACHED_SCENES and total_bytes <= MAX_CACHED_BYTES:
            break
        if session.session_id == _SELECTED_SESSION_ID:
            continue
        _SESSIONS.pop(session.session_id, None)
        shutil.rmtree(session.root, ignore_errors=True)
        count -= 1
        total_bytes -= session.stored_bytes
    if _SELECTED_SESSION_ID not in _SESSIONS:
        _SELECTED_SESSION_ID = None
        _persist_manager_state_locked()


def _manager_summary(session: SceneImportSession) -> dict[str, Any]:
    metadata = session.manifest.get("sceneManager") or {}
    return {
        "sessionId": session.session_id,
        "archiveName": session.manifest.get("archiveName"),
        "xmlPath": session.manifest.get("xmlPath"),
        "sceneVersion": session.manifest.get("sceneVersion"),
        "status": session.manifest.get("status"),
        "activation": session.manifest.get("activation"),
        "selected": session.session_id == _SELECTED_SESSION_ID,
        "state": "selected" if session.session_id == _SELECTED_SESSION_ID else "staged",
        "createdAt": session.created_at,
        "lastAccessedAt": session.last_accessed_at,
        "storedBytes": session.stored_bytes,
        "cacheHitCount": int(metadata.get("cacheHitCount", 0)),
        "archiveSha256": session.archive_sha256,
        "coordinateFrame": session.manifest.get("coordinateFrame"),
        "stats": session.manifest.get("stats"),
    }


def _touch_session_locked(session: SceneImportSession) -> None:
    session.last_accessed_at = _utc_now()
    metadata = session.manifest.setdefault("sceneManager", {})
    metadata["lastAccessedAt"] = session.last_accessed_at
    _persist_session_locked(session)


def create_scene_import_preview(archive_bytes: bytes, archive_name: str, frame: SceneCoordinateFrame) -> dict[str, Any]:
    """Create or reuse a staged scene session for identical archive/frame inputs."""
    global _CACHE_HITS
    if not archive_bytes:
        raise SceneImportError("Uploaded scene archive is empty")
    if len(archive_bytes) > MAX_ARCHIVE_BYTES:
        raise SceneImportError("Scene archive exceeds the 250 MB upload limit")
    archive_sha256 = hashlib.sha256(archive_bytes).hexdigest()
    frame_payload = frame.model_dump(mode="json")
    cache_material = json.dumps(frame_payload, sort_keys=True, separators=(",", ":"))
    cache_key = hashlib.sha256((SCENE_PREVIEW_CACHE_VERSION + "\n" + archive_sha256 + "\n" + cache_material).encode("utf-8")).hexdigest()

    # Serialize cache lookup + construction so two simultaneous identical uploads
    # cannot create duplicate directories or competing selected-scene metadata.
    with _IMPORT_LOCK:
        with _SESSIONS_LOCK:
            _ensure_sessions_restored_locked()
            for session in _SESSIONS.values():
                if session.cache_key and session.cache_key == cache_key and _session_is_valid_on_disk(session):
                    _touch_session_locked(session)
                    _CACHE_HITS += 1
                    manager_meta = session.manifest.setdefault("sceneManager", {})
                    manager_meta["cacheHitCount"] = int(manager_meta.get("cacheHitCount", 0)) + 1
                    _persist_session_locked(session)
                    _persist_manager_state_locked()
                    reused = copy.deepcopy(session.manifest)
                    reused["cacheHit"] = True
                    return reused
        result = _create_scene_import_preview_uncached(
            archive_bytes, archive_name, frame, archive_sha256, cache_key
        )
        result["cacheHit"] = False
        return result


def list_scene_import_sessions() -> dict[str, Any]:
    with _SESSIONS_LOCK:
        _ensure_sessions_restored_locked()
        _prune_sessions_locked()
        sessions = sorted(
            _SESSIONS.values(),
            key=lambda item: _parse_timestamp(item.last_accessed_at),
            reverse=True,
        )
        total_bytes = sum(item.stored_bytes for item in sessions)
        return {
            "sessions": [_manager_summary(item) for item in sessions],
            "selectedSessionId": _SELECTED_SESSION_ID,
            "cache": {
                "sessionCount": len(sessions),
                "storedBytes": total_bytes,
                "maxSessions": MAX_CACHED_SCENES,
                "maxStoredBytes": MAX_CACHED_BYTES,
                "ttlHours": SCENE_SESSION_TTL.total_seconds() / 3600,
                "cacheHits": _CACHE_HITS,
            },
        }


def select_scene_import_session(session_id: str) -> dict[str, Any] | None:
    global _SELECTED_SESSION_ID
    with _SESSIONS_LOCK:
        _ensure_sessions_restored_locked()
        session = _SESSIONS.get(session_id)
        if session is None or not _session_is_valid_on_disk(session):
            return None
        _SELECTED_SESSION_ID = session_id
        _touch_session_locked(session)
        _sync_selection_metadata_locked()
        _persist_manager_state_locked()
        return copy.deepcopy(session.manifest)


def clear_selected_scene_import_session() -> bool:
    global _SELECTED_SESSION_ID
    with _SESSIONS_LOCK:
        _ensure_sessions_restored_locked()
        if _SELECTED_SESSION_ID is None:
            return False
        _SELECTED_SESSION_ID = None
        _sync_selection_metadata_locked()
        _persist_manager_state_locked()
        return True


def get_selected_scene_import_session() -> SceneImportSession | None:
    with _SESSIONS_LOCK:
        _ensure_sessions_restored_locked()
        session = _SESSIONS.get(_SELECTED_SESSION_ID or "")
        if session is not None:
            _touch_session_locked(session)
        return session


def _reset_scene_import_registry_for_tests() -> None:
    global _SESSIONS_RESTORED, _SELECTED_SESSION_ID, _CACHE_HITS
    with _SESSIONS_LOCK:
        _SESSIONS.clear()
        _SESSIONS_RESTORED = False
        _SELECTED_SESSION_ID = None
        _CACHE_HITS = 0


def get_scene_import_session(session_id: str) -> SceneImportSession | None:
    with _SESSIONS_LOCK:
        _ensure_sessions_restored_locked()
        session = _SESSIONS.get(session_id)
        if session is not None and not _session_is_valid_on_disk(session):
            _SESSIONS.pop(session_id, None)
            if _SELECTED_SESSION_ID == session_id:
                _SELECTED_SESSION_ID = None
                _persist_manager_state_locked()
            shutil.rmtree(session.root, ignore_errors=True)
            return None
        if session is not None:
            _touch_session_locked(session)
        return session


def get_scene_import_preview(session_id: str) -> bytes | None:
    session = get_scene_import_session(session_id)
    if not session or not session.preview_path or not session.preview_path.is_file():
        return None
    try:
        return session.preview_path.read_bytes()
    except OSError:
        return None


def delete_scene_import_session(session_id: str) -> bool:
    global _SELECTED_SESSION_ID
    with _SESSIONS_LOCK:
        _ensure_sessions_restored_locked()
        session = _SESSIONS.pop(session_id, None)
        if session is None:
            return False
        if _SELECTED_SESSION_ID == session_id:
            _SELECTED_SESSION_ID = None
        _persist_manager_state_locked()
    shutil.rmtree(session.root, ignore_errors=True)
    return True


def clear_scene_import_sessions() -> int:
    global _SELECTED_SESSION_ID
    with _SESSIONS_LOCK:
        _ensure_sessions_restored_locked()
        sessions = list(_SESSIONS.values())
        _SESSIONS.clear()
        _SELECTED_SESSION_ID = None
        _persist_manager_state_locked()
    for session in sessions:
        shutil.rmtree(session.root, ignore_errors=True)
    return len(sessions)
