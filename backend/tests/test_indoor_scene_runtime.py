from __future__ import annotations

import io
import zipfile
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from backend.scene_coordinates import SceneCoordinateFrame
import backend.scene_import as scene_import
import backend.indoor_scene_runtime as indoor_runtime


def _ply_triangle() -> bytes:
    return b"""ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
3 0 1 2
"""


def _archive(*, transform: bool = False) -> bytes:
    transform_xml = '<transform name="to_world"><translate x="1" y="2" z="3"/></transform>' if transform else ''
    xml = f"""<scene version="2.1.0">
      <bsdf type="diffuse" id="mat-itu_concrete"><rgb name="reflectance" value="0.5 0.5 0.5"/></bsdf>
      <shape type="ply" id="wall_shape">{transform_xml}<string name="filename" value="meshes/wall.ply"/><ref id="mat-itu_concrete"/></shape>
    </scene>""".encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("scene.xml", xml)
        archive.writestr("meshes/wall.ply", _ply_triangle())
    return output.getvalue()


@pytest.fixture
def imported_session(tmp_path, monkeypatch):
    cache_root = tmp_path / "scene-cache"
    monkeypatch.setattr(scene_import, "STAGING_ROOT", cache_root)
    scene_import._reset_scene_import_registry_for_tests()
    indoor_runtime._reset_indoor_scene_runtime_for_tests()
    frame = SceneCoordinateFrame(upAxis="+Y", forwardAxis="+Z", units="cm", handedness="right")
    manifest = scene_import.create_scene_import_preview(_archive(transform=True), "room.zip", frame)
    session = scene_import.get_scene_import_session(manifest["sessionId"])
    assert session is not None
    yield session
    indoor_runtime._reset_indoor_scene_runtime_for_tests()
    scene_import.clear_scene_import_sessions()
    scene_import._reset_scene_import_registry_for_tests()


def test_canonical_runtime_xml_bakes_source_units_axis_and_shape_transform(imported_session):
    output, summary = indoor_runtime._build_canonical_scene_xml(
        imported_session,
        {"mat-itu_concrete": "concrete"},
        28.0,
        {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}},
    )
    root = ET.parse(output).getroot()
    shape = root.find("shape")
    assert shape is not None
    assert shape.attrib["type"] == "ply"
    assert shape.find("transform") is None  # to_world was baked into vertices
    assert shape.find("ref").attrib["id"] == "mat-itu_concrete"
    bsdf = root.find("bsdf")
    assert bsdf.attrib["type"] == "itu-radio-material"
    assert bsdf.find("string[@name='type']").attrib["value"] == "concrete"

    generated = shape.find("string[@name='filename']").attrib["value"]
    canonical_path = output.parent / generated
    mesh = scene_import._load_preview_mesh(canonical_path.read_bytes(), str(canonical_path))
    # Source vertex (0,0,0), after +[1,2,3] cm and Y-up/+Z-forward
    # conversion, becomes canonical (0.03, 0.01, 0.02) metres.
    expected = np.asarray([0.03, 0.01, 0.02])
    assert np.min(np.linalg.norm(np.asarray(mesh.vertices) - expected, axis=1)) < 1e-6
    assert summary["shapeCount"] == 1
    assert summary["vertexCount"] == 3
    assert summary["faceCount"] == 1
    assert summary["canonicalBounds"]["minimum"][0] == pytest.approx(0.03)


def test_activation_rejects_missing_material_mapping_without_fallback(imported_session):
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="Map every referenced"):
        indoor_runtime._build_canonical_scene_xml(
            imported_session, {}, 28.0, {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}}
        )


def test_activation_rejects_material_outside_installed_frequency_range(imported_session):
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="does not support 28 GHz"):
        indoor_runtime._build_canonical_scene_xml(
            imported_session, {"mat-itu_concrete": "floorboard"}, 28.0,
            {"floorboard": {(50.0, 100.0): (1, 2, 3, 4)}},
        )


def test_activate_only_marks_scene_active_after_real_object_and_registry_checks(imported_session, monkeypatch):
    class FakeRadioMaterialBase:
        pass

    radio_material = FakeRadioMaterialBase()

    class FakeSceneObject:
        def __init__(self, material):
            self.mi_mesh = object()
            self.radio_material = material

    class FakeScene:
        def __init__(self):
            self.objects = {"wall_shape": FakeSceneObject(radio_material)}
            self.radio_materials = {"mat-itu_concrete": radio_material}
            self.frequency = None

    calls = {}

    def fake_load_scene(path, *, merge_shapes, remove_duplicate_vertices):
        calls.update(path=path, merge_shapes=merge_shapes, remove_duplicate_vertices=remove_duplicate_vertices)
        return FakeScene()

    monkeypatch.setattr(
        indoor_runtime,
        "_runtime_imports",
        lambda: (object(), fake_load_scene, {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}}, FakeRadioMaterialBase, "2.0.1", "llvm_ad_mono_polarized"),
    )
    result = indoor_runtime.activate_indoor_scene(imported_session, {"mat-itu_concrete": "concrete"}, 28.0)
    assert result["active"] is True
    assert result["sessionId"] == imported_session.session_id
    assert result["summary"]["registeredObjectCount"] == 1
    assert calls["merge_shapes"] is False
    assert calls["remove_duplicate_vertices"] is False
    assert calls["path"].endswith("scene.sionna-runtime.xml")


def test_activate_fails_closed_when_sionna_object_has_no_radio_material(imported_session, monkeypatch):
    class FakeRadioMaterialBase:
        pass

    class FakeSceneObject:
        mi_mesh = object()
        radio_material = None

    class FakeScene:
        objects = {"wall_shape": FakeSceneObject()}
        radio_materials = {"material": FakeRadioMaterialBase()}
        frequency = None

    monkeypatch.setattr(
        indoor_runtime,
        "_runtime_imports",
        lambda: (object(), lambda *a, **k: FakeScene(), {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}}, FakeRadioMaterialBase, "2.0.1", "llvm_ad_mono_polarized"),
    )
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="not assigned a registered RadioMaterial"):
        indoor_runtime.activate_indoor_scene(imported_session, {"mat-itu_concrete": "concrete"}, 28.0)
    assert indoor_runtime.get_indoor_scene_runtime_status()["active"] is False


def test_activation_rejects_multiple_shape_to_world_transforms(imported_session):
    source_xml = imported_session.root / imported_session.manifest["xmlPath"]
    root = ET.parse(source_xml).getroot()
    shape = root.find("shape")
    assert shape is not None
    shape.append(ET.fromstring('<transform name="to_world"><scale value="2"/></transform>'))
    source_xml.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="multiple to_world transforms"):
        indoor_runtime._build_canonical_scene_xml(
            imported_session, {"mat-itu_concrete": "concrete"}, 28.0,
            {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}},
        )


def test_activation_rejects_nested_shape_groups_without_silent_geometry_loss(imported_session):
    source_xml = imported_session.root / imported_session.manifest["xmlPath"]
    root = ET.parse(source_xml).getroot()
    group = ET.SubElement(root, "shapegroup", {"id": "group"})
    ET.SubElement(group, "shape", {"type": "ply", "id": "nested"})
    source_xml.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    with pytest.raises(indoor_runtime.IndoorSceneActivationError, match="Nested Mitsuba <shape>"):
        indoor_runtime._build_canonical_scene_xml(
            imported_session, {"mat-itu_concrete": "concrete"}, 28.0,
            {"concrete": {(1.0, 100.0): (1, 2, 3, 4)}},
        )
