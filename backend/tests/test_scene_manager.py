from __future__ import annotations

import io
import zipfile

import pytest

from backend.scene_coordinates import SceneCoordinateFrame
import backend.scene_import as scene_import


def _ascii_ply() -> bytes:
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


def _zip_scene(name: str = "scene.xml", color: str = "0.5 0.5 0.5") -> bytes:
    xml = f"""<scene version='2.1.0'>
      <bsdf type='diffuse' id='wall'><rgb name='reflectance' value='{color}'/></bsdf>
      <shape type='ply' id='wall_shape'><string name='filename' value='meshes/wall.ply'/><ref id='wall'/></shape>
    </scene>""".encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, xml)
        archive.writestr("meshes/wall.ply", _ascii_ply())
    return output.getvalue()


def _frame(up: str = "+Z", forward: str = "+X", units: str = "m") -> SceneCoordinateFrame:
    return SceneCoordinateFrame(upAxis=up, forwardAxis=forward, units=units, handedness="right")


@pytest.fixture
def isolated_scene_cache(tmp_path, monkeypatch):
    cache_root = tmp_path / "scene-cache"
    monkeypatch.setattr(scene_import, "STAGING_ROOT", cache_root)
    scene_import._reset_scene_import_registry_for_tests()
    yield cache_root
    scene_import.clear_scene_import_sessions()
    scene_import._reset_scene_import_registry_for_tests()


def test_identical_archive_and_frame_reuse_existing_session(isolated_scene_cache):
    archive = _zip_scene()
    first = scene_import.create_scene_import_preview(archive, "first.zip", _frame())
    second = scene_import.create_scene_import_preview(archive, "renamed.zip", _frame())

    assert first["sessionId"] == second["sessionId"]
    assert first.get("cacheHit") is False
    assert second.get("cacheHit") is True
    listing = scene_import.list_scene_import_sessions()
    assert listing["cache"]["sessionCount"] == 1
    assert listing["cache"]["cacheHits"] == 1
    assert listing["sessions"][0]["cacheHitCount"] == 1
    scene_import._reset_scene_import_registry_for_tests()
    restored = scene_import.list_scene_import_sessions()
    assert restored["cache"]["cacheHits"] == 1


def test_coordinate_profile_is_part_of_scene_cache_identity(isolated_scene_cache):
    archive = _zip_scene()
    first = scene_import.create_scene_import_preview(archive, "scene.zip", _frame())
    second = scene_import.create_scene_import_preview(archive, "scene.zip", _frame(up="+Y", forward="+Z", units="cm"))
    assert first["sessionId"] != second["sessionId"]
    assert scene_import.list_scene_import_sessions()["cache"]["sessionCount"] == 2


def test_only_one_scene_can_be_selected_and_selection_does_not_activate_sionna(isolated_scene_cache):
    one = scene_import.create_scene_import_preview(_zip_scene(color="0.3 0.4 0.5"), "one.zip", _frame())
    two = scene_import.create_scene_import_preview(_zip_scene(color="0.6 0.4 0.2"), "two.zip", _frame())

    selected_one = scene_import.select_scene_import_session(one["sessionId"])
    selected_two = scene_import.select_scene_import_session(two["sessionId"])
    assert selected_one["sceneManager"]["selected"] is True
    assert selected_two["sceneManager"]["selected"] is True
    assert selected_two["activation"] == "not_loaded_into_sionna"

    listing = scene_import.list_scene_import_sessions()
    assert listing["selectedSessionId"] == two["sessionId"]
    assert sum(1 for item in listing["sessions"] if item["selected"]) == 1
    assert next(item for item in listing["sessions"] if item["sessionId"] == one["sessionId"])["state"] == "staged"


def test_scene_sessions_and_selected_state_restore_from_disk(isolated_scene_cache):
    result = scene_import.create_scene_import_preview(_zip_scene(), "persist.zip", _frame())
    scene_import.select_scene_import_session(result["sessionId"])

    # Simulate a backend process restart: discard only Python memory, not cache files.
    scene_import._reset_scene_import_registry_for_tests()
    listing = scene_import.list_scene_import_sessions()

    assert listing["selectedSessionId"] == result["sessionId"]
    assert len(listing["sessions"]) == 1
    restored = scene_import.get_scene_import_session(result["sessionId"])
    assert restored is not None
    assert (restored.root / "scene.xml").is_file()
    assert restored.preview_path is not None and restored.preview_path.is_file()


def test_delete_selected_scene_clears_manager_selection(isolated_scene_cache):
    result = scene_import.create_scene_import_preview(_zip_scene(), "delete.zip", _frame())
    scene_import.select_scene_import_session(result["sessionId"])
    assert scene_import.delete_scene_import_session(result["sessionId"]) is True
    listing = scene_import.list_scene_import_sessions()
    assert listing["selectedSessionId"] is None
    assert listing["sessions"] == []


def test_cache_evicts_least_recently_used_unselected_sessions(isolated_scene_cache, monkeypatch):
    monkeypatch.setattr(scene_import, "MAX_CACHED_SCENES", 2)
    one = scene_import.create_scene_import_preview(_zip_scene(color="0.1 0.1 0.1"), "one.zip", _frame())
    two = scene_import.create_scene_import_preview(_zip_scene(color="0.2 0.2 0.2"), "two.zip", _frame())
    scene_import.select_scene_import_session(two["sessionId"])
    three = scene_import.create_scene_import_preview(_zip_scene(color="0.3 0.3 0.3"), "three.zip", _frame())

    listing = scene_import.list_scene_import_sessions()
    ids = {item["sessionId"] for item in listing["sessions"]}
    assert two["sessionId"] in ids  # selected entries are protected from eviction
    assert three["sessionId"] in ids
    assert one["sessionId"] not in ids


def test_clearing_selection_retains_the_staged_session(isolated_scene_cache):
    result = scene_import.create_scene_import_preview(_zip_scene(), "keep_staged.zip", _frame())
    scene_import.select_scene_import_session(result["sessionId"])
    assert scene_import.clear_selected_scene_import_session() is True
    listing = scene_import.list_scene_import_sessions()
    assert listing["selectedSessionId"] is None
    assert len(listing["sessions"]) == 1
    assert listing["sessions"][0]["state"] == "staged"
    assert scene_import.get_scene_import_session(result["sessionId"]) is not None
