from __future__ import annotations

import pytest

from backend import experiment_store


def _isolated_store(monkeypatch, tmp_path):
    monkeypatch.setenv("SIONNA_RT_STUDIO_DATA_DIR", str(tmp_path))
    experiment_store.init_experiment_store()


def test_experiment_create_update_list_delete(monkeypatch, tmp_path):
    _isolated_store(monkeypatch, tmp_path)
    created = experiment_store.create_experiment({
        "name": "Test link solve",
        "kind": "link_solve",
        "status": "running",
        "configuration": {"freqGhz": 3.4896, "maxDepth": 3},
        "parameters": {"tx": "tx_1"},
        "results": {},
        "seed": 42,
    })
    assert created["status"] == "running"
    assert len(created["configurationFingerprint"]) == 64
    assert created["seed"] == 42

    updated = experiment_store.update_experiment(created["id"], {
        "status": "done", "durationMs": 123.4,
        "results": {"numPaths": 7, "receivedPowerDbm": -81.2},
    })
    assert updated is not None
    assert updated["status"] == "done"
    assert updated["results"]["numPaths"] == 7
    updated = experiment_store.update_experiment(created["id"], {"configurationFingerprint": "a" * 64})
    assert updated is not None and updated["configurationFingerprint"] == "a" * 64
    assert experiment_store.list_experiments()[0]["id"] == created["id"]
    assert experiment_store.delete_experiment(created["id"]) is True
    assert experiment_store.list_experiments() == []


def test_presets_are_persistent_and_names_are_unique(monkeypatch, tmp_path):
    _isolated_store(monkeypatch, tmp_path)
    preset = experiment_store.create_preset(
        "Campus n78", "Validated test configuration", {"freqGhz": 3.4896, "maxDepth": 5},
    )
    assert preset["configuration"]["maxDepth"] == 5
    assert preset["configurationFingerprint"]
    assert experiment_store.list_presets()[0]["id"] == preset["id"]
    with pytest.raises(ValueError, match="already exists"):
        experiment_store.create_preset("Campus n78", "duplicate", {"freqGhz": 3.5})
    assert experiment_store.delete_preset(preset["id"]) is True
    assert experiment_store.list_presets() == []


def test_json_payload_rejects_non_finite_values(monkeypatch, tmp_path):
    _isolated_store(monkeypatch, tmp_path)
    with pytest.raises(ValueError, match="finite JSON"):
        experiment_store.create_experiment({
            "name": "bad", "kind": "bad", "configuration": {"value": float("nan")},
        })


def test_running_experiments_are_recovered_after_backend_restart(monkeypatch, tmp_path):
    _isolated_store(monkeypatch, tmp_path)
    created = experiment_store.create_experiment({
        "name": "Interrupted run", "kind": "measurement_raytrace", "status": "running",
        "configuration": {"seed": 7}, "results": {"jobId": "mrt_test"},
    })
    experiment_store.init_experiment_store()  # simulate a new backend process opening the DB
    recovered = experiment_store.list_experiments()[0]
    assert recovered["id"] == created["id"]
    assert recovered["status"] == "error"
    assert "Backend restarted" in recovered["error"]


def test_oversized_replay_does_not_drop_experiment_record(monkeypatch, tmp_path):
    _isolated_store(monkeypatch, tmp_path)
    created = experiment_store.create_experiment({
        "name": "Large scene solve", "kind": "link_solve", "status": "done",
        "configuration": {"freqGhz": 3.5}, "results": {"pathCount": 2},
        "replay": {"endpoint": "/api/solve", "body": {"buildings": "x" * (experiment_store.MAX_JSON_BYTES + 100)}},
    })
    assert created["replay"] is None
    assert "replayUnavailableReason" in created["results"]
    assert created["results"]["pathCount"] == 2
