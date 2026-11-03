> **Modification notice:** This file has been modified in the `alexandarM/SionnaRTStudio` fork of `puloktarafder/SionnaRTStudio`.
> Upstream: https://github.com/puloktarafder/SionnaRTStudio

# AGENTS.md — SionnaRTStudio

Repository guidance for contributors and coding agents.

## Project Overview

SionnaRTStudio is a browser-based wireless digital twin built on NVIDIA Sionna RT.
The frontend uses React, TypeScript, Three.js and Vite. The backend uses FastAPI,
Python, Mitsuba and Sionna RT.

## Project Layout

- `src/` — React application, UI components, API client, state and visualization utilities.
- `backend/` — FastAPI routes, scene construction, Sionna solvers, RF analysis and tests.
- `docs/` — architecture notes, scientific assumptions, module guides and acceptance procedures.
- `scripts/` — setup/runtime helpers and focused frontend validation scripts.
- `assets/` — application logos and static assets.

## Running the Application

- Run `./setup.sh` once to install the project-local Node.js toolchain, frontend dependencies and Python backend dependencies.
- Run `./run.sh` to start the FastAPI backend on port `8000` and the Vite frontend on port `3000`.
- Use `SRTS_BACKEND_PORT` to select another backend port and `SRTS_PYTHON` to select an existing Python environment.
- Set `SIONNA_RT_STUDIO_DATA_DIR` before backend startup to store the experiment database outside the project directory, such as on persistent Google Drive storage in Colab.
- The frontend proxies `/api` requests to the backend. When using a remote notebook, expose the frontend port through the notebook's tunnel mechanism.

## Validation

- Backend regression suite: `python -m pytest -q backend/tests`.
- Python syntax check: `python -m compileall -q backend`.
- Shell syntax check: `bash -n run.sh setup.sh scripts/runtime-env.sh`.
- Frontend type-check: `npm run lint` after installing dependencies.
- Frontend production build: `npm run build` after installing dependencies.
- Focused panel lifecycle check: `node scripts/check-panel-lifecycle.mjs`.
- Additional TypeScript validation scripts are listed in `package.json` and require the project dependencies.

## Solver and Scene Guidelines

- Mitsuba's CPU variant `llvm_ad_mono_polarized` can be used for supported solver-level tests on machines without a CUDA GPU. Set the variant before importing modules that initialize the backend scene or solver.
- The backend normally prefers `cuda_ad_mono_polarized` when a compatible NVIDIA GPU is available. Check `/api/health` to inspect the active variant and GPU availability.
- Preserve the distinction between scene-local ENU coordinates and geographic coordinates. Do not substitute UTM or WGS84 values directly into the local Sionna scene.
- Do not interpret generic Sionna RT received power as modem SS-RSRP without a like-for-like reference-signal and receiver model.
- Preserve RF configuration snapshots and their fingerprints when changing ray-tracing workflows so experiments remain auditable.

## Mobility and Batched Path Solving

The mobility workflow samples receiver waypoints and solves all configured transmitters in a batched PathSolver dispatch when possible. The backend returns per-transmitter results, selects the strongest-RSS transmitter for best-server KPIs, and can also provide non-coherent sum-power metrics.

All transmitters in a batched radio-map or mobility solve must share the scene's transmitter-array configuration. Keep the defensive serial fallback and its execution telemetry intact when modifying batching behavior.

## Sionna RT Tensor Shapes

With `synthetic_array=True`, geometric tensors carry explicit receiver and transmitter axes. Typical shapes include:

- `valid`, `tau`, `doppler`, and angular tensors: `(num_rx, num_tx, num_paths)`.
- `interactions`: `(depth, num_rx, num_tx, num_paths)`.
- `vertices`: `(..., 3)`.
- Path coefficients `a`: `(num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths)`.

Do not collapse antenna or device axes unless the API contract explicitly defines the reduction.

## Optional NR PHY Dependency

The Sionna PHY chain is optional and is installed separately through `backend/requirements-phy.txt`. It uses a CPU-pinned PHY device so that PyTorch does not compete with Mitsuba for the ray-tracing GPU. Keep heavy PHY imports inside the relevant job path so the base application remains usable without the optional package.

## Data privacy

- Use synthetic coordinates, radio identifiers, and filenames in automated tests and examples.
- Do not commit private field-measurement CSVs, GPS tracks, route maps, exact scene anchors, or unredacted transmitter inventories.
- Before publishing screenshots, logs, notebook outputs, or CSV examples, remove exact coordinates, route geometry, device identifiers, and non-public radio/network identifiers.
- Keep expected measurement counts and coordinate bounds dataset-dependent; do not copy values from a private field campaign into public documentation.
