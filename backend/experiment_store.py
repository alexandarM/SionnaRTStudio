"""Persistent experiment history and RF configuration presets.

The database lives under ``SIONNA_RT_STUDIO_DATA_DIR`` when configured, otherwise
in the project-local ``data/`` directory. SQLite WAL keeps reads responsive
while a long Sionna solve is running in another worker thread.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_JSON_BYTES = 8 * 1024 * 1024


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    root = Path(os.environ.get("SIONNA_RT_STUDIO_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
    root.mkdir(parents=True, exist_ok=True)
    return root / "experiments.sqlite3"


def _json_dump(value: Any) -> str:
    try:
        result = json.dumps(value if value is not None else {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Experiment data must be finite JSON-compatible values: {exc}") from exc
    if len(result.encode("utf-8")) > MAX_JSON_BYTES:
        raise ValueError(f"Experiment JSON exceeds the {MAX_JSON_BYTES // (1024 * 1024)} MiB storage limit")
    return result


def _fingerprint(configuration: Any) -> str:
    return hashlib.sha256(_json_dump(configuration).encode("utf-8")).hexdigest()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_experiment_store() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS experiment_runs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at_utc TEXT NOT NULL,
                completed_at_utc TEXT,
                duration_ms REAL,
                configuration_fingerprint TEXT NOT NULL,
                configuration_json TEXT NOT NULL,
                seed INTEGER,
                parameters_json TEXT NOT NULL,
                results_json TEXT NOT NULL,
                error TEXT,
                replay_json TEXT,
                created_at_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_experiment_runs_started
                ON experiment_runs(started_at_utc DESC);
            CREATE INDEX IF NOT EXISTS idx_experiment_runs_kind
                ON experiment_runs(kind, started_at_utc DESC);
            CREATE TABLE IF NOT EXISTS configuration_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                configuration_json TEXT NOT NULL,
                configuration_fingerprint TEXT NOT NULL,
                created_at_utc TEXT NOT NULL,
                updated_at_utc TEXT NOT NULL
            );
            """
        )
        # Background jobs live in process memory. Any record left as running
        # when a fresh backend process opens the store cannot still be active.
        conn.execute(
            "UPDATE experiment_runs SET status='error', completed_at_utc=?, "
            "error=COALESCE(error, ?) WHERE status='running'",
            (_utc_now(), "Backend restarted before this experiment reached a terminal state."),
        )


def _run_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "kind": row["kind"], "status": row["status"],
        "startedAtUtc": row["started_at_utc"], "completedAtUtc": row["completed_at_utc"],
        "durationMs": row["duration_ms"], "configurationFingerprint": row["configuration_fingerprint"],
        "configuration": json.loads(row["configuration_json"]),
        "seed": row["seed"], "parameters": json.loads(row["parameters_json"]),
        "results": json.loads(row["results_json"]), "error": row["error"],
        "replay": json.loads(row["replay_json"]) if row["replay_json"] else None,
    }


def create_experiment(payload: dict[str, Any]) -> dict[str, Any]:
    configuration = payload.get("configuration") or {}
    fingerprint = payload.get("configurationFingerprint") or _fingerprint(configuration)
    if not isinstance(fingerprint, str) or len(fingerprint) > 128:
        raise ValueError("configurationFingerprint must be a string up to 128 characters")
    run_id = str(payload.get("id") or uuid.uuid4())
    started = str(payload.get("startedAtUtc") or _utc_now())
    config_json = _json_dump(configuration)
    params_json = _json_dump(payload.get("parameters") or {})
    results_payload = dict(payload.get("results") or {})
    replay = payload.get("replay")
    replay_json = None
    if replay is not None:
        try:
            replay_json = _json_dump(replay)
        except ValueError as exc:
            # A large OSM scene can make an otherwise useful run payload exceed
            # the replay storage cap. Preserve the experiment record and explain
            # why Retry is unavailable instead of dropping the whole run.
            results_payload["replayUnavailableReason"] = str(exc)[:400]
    results_json = _json_dump(results_payload)
    with _connect() as conn:
        conn.execute(
            """INSERT INTO experiment_runs
               (id,name,kind,status,started_at_utc,completed_at_utc,duration_ms,
                configuration_fingerprint,configuration_json,seed,parameters_json,results_json,error,replay_json,created_at_utc)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (run_id, str(payload["name"]), str(payload["kind"]), str(payload.get("status", "done")),
             started, payload.get("completedAtUtc"), payload.get("durationMs"), fingerprint,
             config_json, payload.get("seed"), params_json, results_json, payload.get("error"), replay_json, _utc_now()),
        )
        row = conn.execute("SELECT * FROM experiment_runs WHERE id=?", (run_id,)).fetchone()
    return _run_row(row)


def update_experiment(run_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"status", "completedAtUtc", "durationMs", "results", "error", "replay", "configurationFingerprint"}
    values: dict[str, Any] = {key: value for key, value in payload.items() if key in allowed}
    assignments: list[str] = []
    params: list[Any] = []
    mapping = {
        "status": "status", "completedAtUtc": "completed_at_utc", "durationMs": "duration_ms",
        "error": "error", "configurationFingerprint": "configuration_fingerprint",
    }
    for key, column in mapping.items():
        if key in values:
            assignments.append(f"{column}=?")
            params.append(values[key])
    if "results" in values:
        assignments.append("results_json=?")
        params.append(_json_dump(values["results"]))
    if "replay" in values:
        assignments.append("replay_json=?")
        params.append(_json_dump(values["replay"]) if values["replay"] is not None else None)
    if not assignments:
        with _connect() as conn:
            row = conn.execute("SELECT * FROM experiment_runs WHERE id=?", (run_id,)).fetchone()
        return _run_row(row) if row else None
    params.append(run_id)
    with _connect() as conn:
        conn.execute(f"UPDATE experiment_runs SET {', '.join(assignments)} WHERE id=?", params)
        row = conn.execute("SELECT * FROM experiment_runs WHERE id=?", (run_id,)).fetchone()
    return _run_row(row) if row else None


def list_experiments(limit: int = 200) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit), 1000))
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM experiment_runs ORDER BY started_at_utc DESC, created_at_utc DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
    return [_run_row(row) for row in rows]


def delete_experiment(run_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM experiment_runs WHERE id=?", (run_id,))
    return cur.rowcount > 0


def _preset_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "description": row["description"],
        "configuration": json.loads(row["configuration_json"]),
        "configurationFingerprint": row["configuration_fingerprint"],
        "createdAtUtc": row["created_at_utc"], "updatedAtUtc": row["updated_at_utc"],
    }


def create_preset(name: str, description: str, configuration: dict[str, Any]) -> dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Preset name cannot be empty")
    if len(clean_name) > 100:
        raise ValueError("Preset name must be 100 characters or fewer")
    config_json = _json_dump(configuration)
    fingerprint = _fingerprint(configuration)
    preset_id = str(uuid.uuid4())
    now = _utc_now()
    try:
        with _connect() as conn:
            conn.execute(
                """INSERT INTO configuration_presets
                   (id,name,description,configuration_json,configuration_fingerprint,created_at_utc,updated_at_utc)
                   VALUES (?,?,?,?,?,?,?)""",
                (preset_id, clean_name, description[:500], config_json, fingerprint, now, now),
            )
            row = conn.execute("SELECT * FROM configuration_presets WHERE id=?", (preset_id,)).fetchone()
    except sqlite3.IntegrityError as exc:
        raise ValueError(f"A preset named '{clean_name}' already exists") from exc
    return _preset_row(row)


def list_presets() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM configuration_presets ORDER BY name COLLATE NOCASE").fetchall()
    return [_preset_row(row) for row in rows]


def delete_preset(preset_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM configuration_presets WHERE id=?", (preset_id,))
    return cur.rowcount > 0
