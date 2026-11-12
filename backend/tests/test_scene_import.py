from __future__ import annotations

import io
import zipfile

import pytest
import trimesh
import numpy as np

from backend.scene_coordinates import SceneCoordinateFrame
from backend.scene_import import (
    SceneImportError,
    create_scene_import_preview,
    delete_scene_import_session,
    get_scene_import_preview,
    get_scene_import_session,
)


def _ascii_ply() -> bytes:
    return b"""ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 2
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
1 1 0
0 1 1
3 0 1 2
3 0 2 3
"""


def _zip_scene(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


def _frame(up="+Z", forward="+X", units="m", handedness="right"):
    return SceneCoordinateFrame(
        upAxis=up,
        forwardAxis=forward,
        units=units,
        handedness=handedness,
    )


def test_scene_import_preview_inventory_and_glb_round_trip():
    xml = b"""<scene version='2.1.0'>
      <bsdf type='twosided' id='mat-itu-concrete.003'><bsdf type='diffuse'/></bsdf>
      <bsdf type='twosided' id='mat-itu-glass'><bsdf type='diffuse'/></bsdf>
      <shape type='ply' id='wall_a' name='Wall A'><string name='filename' value='meshes/wall.ply'/><ref id='mat-itu-concrete.003'/></shape>
      <shape type='ply' id='window_a'><string name='filename' value='meshes/window.ply'/><ref id='mat-itu-glass'/></shape>
      <bsdf type='diffuse' id='unused_material'/>
    </scene>"""
    archive = _zip_scene({
        "scene.xml": xml,
        "meshes/wall.ply": _ascii_ply(),
        "meshes/window.ply": _ascii_ply(),
        "textures/readme.png": b"not referenced but safely staged",
    })
    result = create_scene_import_preview(archive, "unit_test.zip", _frame())
    assert result["status"] == "preview_ready"
    assert result["activation"] == "not_loaded_into_sionna"
    assert result["stats"]["shapeCount"] == 2
    assert result["stats"]["previewedShapeCount"] == 2
    assert result["stats"]["materialCount"] == 3
    assert result["stats"]["referencedMaterialCount"] == 2
    assert result["materials"][0]["shapeCount"] >= 0
    assert any(m["id"] == "mat-itu-concrete.003" and m["nameHint"] == "concrete" for m in result["materials"])
    preview = get_scene_import_preview(result["sessionId"])
    assert preview and preview[:4] == b"glTF"
    session = get_scene_import_session(result["sessionId"])
    assert session is not None
    assert session.root.joinpath("scene.xml").is_file()
    assert delete_scene_import_session(result["sessionId"]) is True
    assert get_scene_import_session(result["sessionId"]) is None


def test_scene_import_applies_generic_coordinate_profile_and_unit_scale():
    xml = b"""<scene><shape type='ply' id='mesh'><string name='filename' value='m.ply'/></shape></scene>"""
    archive = _zip_scene({"scene.xml": xml, "m.ply": _ascii_ply()})
    result = create_scene_import_preview(
        archive,
        "centimetres_y_up.zip",
        _frame(up="+Y", forward="+Z", units="cm"),
    )
    assert result["coordinateFrame"]["upAxis"] == "+Y"
    assert result["canonicalFrame"]["upAxis"] == "+Z"
    assert result["canonicalBounds"] is not None
    assert result["coordinateTransform"]["scaleToMeters"] == 0.01
    delete_scene_import_session(result["sessionId"])


def test_scene_import_rejects_missing_mesh_resources():
    xml = b"<scene><shape type='ply'><string name='filename' value='meshes/missing.ply'/></shape></scene>"
    with pytest.raises(SceneImportError, match="missing archive resource"):
        create_scene_import_preview(_zip_scene({"scene.xml": xml}), "missing.zip", _frame())


def test_scene_import_rejects_path_traversal_in_zip():
    xml = b"<scene/>"
    with pytest.raises(SceneImportError, match="Unsafe archive path"):
        create_scene_import_preview(_zip_scene({"../escape.xml": xml}), "unsafe.zip", _frame())


def test_scene_import_rejects_path_traversal_in_xml_reference():
    xml = b"<scene><shape type='ply'><string name='filename' value='../outside.ply'/></shape></scene>"
    with pytest.raises(SceneImportError, match="escapes the archive"):
        create_scene_import_preview(_zip_scene({"scene.xml": xml}), "unsafe_ref.zip", _frame())


def test_scene_import_requires_single_mitsuba_scene_xml():
    xml = b"<scene/>"
    with pytest.raises(SceneImportError, match="multiple Mitsuba scene XML files"):
        create_scene_import_preview(
            _zip_scene({"a.xml": xml, "b.xml": xml}), "two_scenes.zip", _frame()
        )


def test_scene_import_rejects_dtd_and_entities():
    xml = b"<!DOCTYPE scene [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><scene>&x;</scene>"
    with pytest.raises(SceneImportError, match="DTD/entity"):
        create_scene_import_preview(_zip_scene({"scene.xml": xml}), "entity.zip", _frame())


def test_scene_import_reports_non_ply_shape_types_without_failing_inventory():
    xml = b"""<scene>
      <shape type='sphere' id='ball'><float name='radius' value='1'/></shape>
      <shape type='ply' id='mesh'><string name='filename' value='mesh.ply'/></shape>
    </scene>"""
    result = create_scene_import_preview(
        _zip_scene({"scene.xml": xml, "mesh.ply": _ascii_ply()}), "mixed_shapes.zip", _frame()
    )
    assert result["stats"]["shapeCount"] == 2
    assert result["stats"]["unsupportedShapeCount"] == 1
    assert result["unsupportedShapeTypes"] == {"sphere": 1}
    delete_scene_import_session(result["sessionId"])


def test_scene_import_applies_shape_to_world_transform_before_frame_conversion():
    xml = b"""<scene><shape type='ply' id='translated_mesh'>
      <transform name='to_world'><translate x='1' y='2' z='3'/></transform>
      <string name='filename' value='mesh.ply'/>
    </shape></scene>"""
    result = create_scene_import_preview(
        _zip_scene({"scene.xml": xml, "mesh.ply": _ascii_ply()}),
        "transformed.zip",
        _frame(up="+Y", forward="+Z", units="cm"),
    )
    bounds = result["canonicalBounds"]
    assert bounds is not None
    assert bounds["minimum"] == pytest.approx([0.03, 0.01, 0.02])
    assert bounds["maximum"] == pytest.approx([0.04, 0.02, 0.03])
    delete_scene_import_session(result["sessionId"])


def test_scene_import_supports_obj_preview_meshes():
    obj = b"""o triangle
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
"""
    xml = b"<scene><shape type='obj' id='triangle'><string name='filename' value='meshes/triangle.obj'/></shape></scene>"
    result = create_scene_import_preview(
        _zip_scene({"scene.xml": xml, "meshes/triangle.obj": obj}),
        "obj_scene.zip",
        _frame(),
    )
    assert result["stats"]["previewedShapeCount"] == 1
    assert result["objects"][0]["vertexCount"] == 3
    assert result["previewUrl"] is not None
    delete_scene_import_session(result["sessionId"])


def _load_glb_materials(preview_bytes: bytes):
    scene = trimesh.load(io.BytesIO(preview_bytes), file_type="glb", force="scene")
    return list(scene.geometry.values())


def test_preview_material_uses_nested_mitsuba_diffuse_reflectance_not_generated_palette():
    xml = b"""<scene>
      <bsdf type='twosided' id='mat-itu-concrete'>
        <bsdf type='diffuse' name='bsdf'><rgb name='reflectance' value='0.12 0.34 0.56'/></bsdf>
      </bsdf>
      <shape type='ply' id='wall'><string name='filename' value='wall.ply'/><ref id='mat-itu-concrete'/></shape>
    </scene>"""
    result = create_scene_import_preview(
        _zip_scene({"scene.xml": xml, "wall.ply": _ascii_ply()}),
        "bsdf_color.zip",
        _frame(),
    )
    material = result["materials"][0]
    assert material["previewColorLinear"] == pytest.approx([0.12, 0.34, 0.56])
    assert material["previewSource"] == "twosided/rgb_reflectance"
    meshes = _load_glb_materials(get_scene_import_preview(result["sessionId"]))
    pbr = meshes[0].visual.material
    assert list(pbr.baseColorFactor[:3]) == pytest.approx([31, 87, 143], abs=1)
    delete_scene_import_session(result["sessionId"])


def test_preview_material_preserves_bitmap_texture_and_ply_uv_coordinates():
    from PIL import Image

    ply = b"""ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
property float s
property float t
element face 2
property list uchar int vertex_indices
end_header
0 0 0 0 0
1 0 0 1 0
1 1 0 1 1
0 1 0 0 1
3 0 1 2
3 0 2 3
"""
    png_buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (180, 120, 60)).save(png_buffer, format="PNG")
    xml = b"""<scene>
      <bsdf type='twosided' id='floor_mat'>
        <bsdf type='diffuse'><texture type='bitmap' name='reflectance'><string name='filename' value='textures/floor.png'/></texture></bsdf>
      </bsdf>
      <shape type='ply' id='floor'><string name='filename' value='meshes/floor.ply'/><ref id='floor_mat'/></shape>
    </scene>"""
    result = create_scene_import_preview(
        _zip_scene({"scene.xml": xml, "meshes/floor.ply": ply, "textures/floor.png": png_buffer.getvalue()}),
        "bitmap_scene.zip",
        _frame(),
    )
    material = result["materials"][0]
    assert material["previewSource"] == "twosided/bitmap_reflectance"
    assert material["previewTexturePath"] == "textures/floor.png"
    assert material["previewTextureApplied"] is True
    assert result["stats"]["materialsWithTexturePreview"] == 1
    mesh = _load_glb_materials(get_scene_import_preview(result["sessionId"]))[0]
    assert mesh.visual.uv is not None
    assert mesh.visual.uv.shape == (4, 2)
    assert mesh.visual.material.baseColorTexture is not None
    # A bitmap must not be multiplied by its own average color.
    assert list(mesh.visual.material.baseColorFactor) == [255, 255, 255, 255]
    delete_scene_import_session(result["sessionId"])


def test_preview_approximates_roughconductor_and_blendbsdf_parameters():
    from backend.scene_import import _resolve_bsdf_visual
    import xml.etree.ElementTree as ET

    conductor = ET.fromstring(
        "<bsdf type='twosided'><bsdf type='roughconductor'>"
        "<float name='alpha' value='0.04'/><rgb name='specular_reflectance' value='0.7 0.8 0.9'/>"
        "</bsdf></bsdf>"
    )
    conductor_preview = _resolve_bsdf_visual(conductor, "scene.xml", {})
    assert conductor_preview["baseColorLinear"] == pytest.approx((0.7, 0.8, 0.9))
    assert conductor_preview["metallicFactor"] == pytest.approx(1.0)
    assert conductor_preview["roughnessFactor"] == pytest.approx(0.2)

    blend = ET.fromstring(
        "<bsdf type='blendbsdf'><float name='weight' value='0.25'/>"
        "<bsdf name='bsdf1' type='diffuse'><rgb name='reflectance' value='0 0 0'/></bsdf>"
        "<bsdf name='bsdf2' type='roughconductor'><rgb name='specular_reflectance' value='1 1 1'/></bsdf>"
        "</bsdf>"
    )
    blend_preview = _resolve_bsdf_visual(blend, "scene.xml", {})
    assert blend_preview["baseColorLinear"] == pytest.approx((0.25, 0.25, 0.25))
    assert blend_preview["metallicFactor"] == pytest.approx(0.25)


def test_preview_keeps_explicit_source_ply_vertex_colors():
    ply = b"""ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 2
property list uchar int vertex_indices
end_header
0 0 0 255 0 0
1 0 0 0 255 0
1 1 0 0 0 255
0 1 1 255 255 255
3 0 1 2
3 0 2 3
"""
    xml = b"""<scene>
      <bsdf type='diffuse' id='source_material'><rgb name='reflectance' value='0.1 0.2 0.3'/></bsdf>
      <shape type='ply' id='colored_mesh'><string name='filename' value='colored.ply'/><ref id='source_material'/></shape>
    </scene>"""
    result = create_scene_import_preview(
        _zip_scene({"scene.xml": xml, "colored.ply": ply}),
        "vertex_colors.zip",
        _frame(),
    )
    mesh = _load_glb_materials(get_scene_import_preview(result["sessionId"]))[0]
    colors = np.asarray(mesh.visual.vertex_colors)
    assert colors.shape[0] == 4
    assert colors[0, :3] == pytest.approx([255, 0, 0], abs=1)
    assert colors[1, :3] == pytest.approx([0, 255, 0], abs=1)
    delete_scene_import_session(result["sessionId"])


def test_preview_raw_bitmap_is_encoded_for_gltf_srgb_sampling():
    from PIL import Image
    from backend.scene_import import _texture_from_node
    import xml.etree.ElementTree as ET

    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), (128, 128, 128)).save(buffer, format="PNG")
    texture_node = ET.fromstring(
        "<texture type='bitmap' name='reflectance'>"
        "<boolean name='raw' value='true'/>"
        "<string name='filename' value='raw.png'/>"
        "</texture>"
    )
    image, resource, warning = _texture_from_node(texture_node, "scene.xml", {"raw.png": buffer.getvalue()})
    assert resource == "raw.png"
    assert warning is None
    assert image is not None
    # Linear 0.502 should be encoded near sRGB 0.737 (about 188/255).
    assert image.getpixel((0, 0))[0] == pytest.approx(188, abs=1)
