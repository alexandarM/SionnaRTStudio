> **Modification notice:** This file has been modified in the `alexandarM/SionnaRTStudio` fork of `puloktarafder/SionnaRTStudio`.
> Upstream: https://github.com/puloktarafder/SionnaRTStudio

<div align="center">

<img src="assets/SionnaRTStudio-bone.png" alt="SionnaRTStudio — Wireless Digital Twin" width="760"/>

**A browser-based wireless digital twin powered by NVIDIA Sionna RT GPU ray tracing.**

[![GitHub repository](https://img.shields.io/badge/GitHub-alexandarM%2FSionnaRTStudio-181717?logo=github)](https://github.com/alexandarM/SionnaRTStudio)
[![Forked from upstream](https://img.shields.io/badge/forked%20from-puloktarafder%2FSionnaRTStudio-blue?logo=github)](https://github.com/puloktarafder/SionnaRTStudio)
[![Sionna RT](https://img.shields.io/badge/Sionna%20RT-NVlabs-76B900?logo=nvidia&logoColor=white)](https://github.com/NVlabs/sionna-rt)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript 5.8](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Three.js r184](https://img.shields.io/badge/Three.js-r184-000000?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Vite 6](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![CUDA GPU](https://img.shields.io/badge/CUDA-GPU%20recommended-76B900?logo=nvidia&logoColor=white)](https://developer.nvidia.com/cuda-toolkit)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Upstream DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22064926.svg)](https://doi.org/10.5281/zenodo.22064926)

</div>

---

**This repository is the `alexandarM/SionnaRTStudio` fork of the original [`puloktarafder/SionnaRTStudio`](https://github.com/puloktarafder/SionnaRTStudio).** The upstream author and Apache-2.0 notices are retained; this fork adds research workflows and a dedicated Google Colab launcher. See [Fork origin and attribution](#fork-origin-and-attribution).

**SionnaRTStudio** turns any real-world location into an interactive wireless propagation
sandbox. Pick an area on a map, pull its buildings from **OpenStreetMap**, place
transmitters and receivers inside a 3D digital twin, and run **NVIDIA
[Sionna RT](https://github.com/NVlabs/sionna-rt)** GPU ray tracing — multipath links,
coverage maps, multi-transmitter receiver mobility with 3GPP A3 handover analysis,
Shannon-capacity link KPIs, an optional standard-compliant 5G NR PUSCH BER/BLER
chain, and notebook-grade channel-response exports (CIR / CFR) — all from the
browser.

> **Google Colab support:** use the included [Colab Launcher notebook](SionnaRTStudio_Colab_Launcher.ipynb), or open it directly in Colab with the badge below.
> The launcher clones the configured fork, installs the project dependencies, checks the backend/frontend health endpoints, opens the Colab port proxy, and can store the experiment database on Google Drive.
>
> [![Open in Google Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/alexandarM/SionnaRTStudio/blob/main/SionnaRTStudio_Colab_Launcher.ipynb)
>
> **New to SionnaRTStudio?** Follow the
> **[upstream step-by-step tutorial by Pulok Tarafder](https://puloktarafder.github.io/posts/2026/08/sionnartstudio-tutorial/)**
> for setup, interface navigation, ray-traced links, coverage maps, mobility
> trajectories, analysis tools, research exports, and standalone Sionna RT
> notebook workflows.

## Table of contents

- [Changelog](CHANGELOG.md)

- [Requirements](#requirements)
- [Quick start](#quick-start)
  - [Windows (WSL2)](#windows-wsl2)
  - [How Node is resolved](#how-node-is-resolved)
- [Google Colab notebook support](#google-colab-notebook-support)
- [Features](#features)
- [Architecture](#architecture)
- [City-scale preview streaming and LOD](#city-scale-preview-streaming-and-lod)
- [Using it](#using-it)
- [Channel-response exports (CIR / CFR)](#channel-response-exports-cir--cfr)
- [Standalone Sionna RT scene export](#standalone-sionna-rt-scene-export)
- [Freezing an OSM scene](#freezing-an-osm-scene)
- [Testing and validation](#testing-and-validation)
- [Troubleshooting](#troubleshooting)
- [Notes](#notes)
- [Fork origin and attribution](#fork-origin-and-attribution)
- [Citation](#citation)
- [License](#license)

> **Field-data privacy:** This repository does not include private field-measurement datasets, GPS tracks, route maps, exact field coordinate bounds, or non-public base-station inventories. See [`docs/testing/README.md`](docs/testing/README.md) before sharing screenshots, logs, or sample exports.

## Requirements

- **Linux, macOS, and Windows via WSL2** — `setup.sh` and `run.sh` are bash scripts that
  assume a POSIX venv layout, so there is no native Windows (cmd/PowerShell)
  path. See [Windows (WSL2)](#windows-wsl2). macOS installs on Apple Silicon and
  runs CPU-only; Intel Macs have no Mitsuba wheel at all.
- **NVIDIA GPU + CUDA** — strongly recommended, not required. Ray tracing prefers
  Mitsuba's `cuda_ad_mono_polarized` variant and falls back to the CPU
  (`llvm_ad_mono_polarized`) when no usable GPU is present. Results are
  identical; only speed differs. `GET /api/health` reports the active `variant`
  and a `gpu` boolean. Whether a VM sees the GPU depends entirely on the
  hypervisor: **WSL2 passes an NVIDIA GPU through, VirtualBox does not.**
- **LLVM runtime — only on machines with no CUDA GPU.** Dr.Jit's CPU backend
  `dlopen`s a system `libLLVM`; it is *not* bundled in the wheel. `setup.sh`
  handles both supported platforms: Ubuntu uses `sudo apt install llvm-runtime`
  when missing; on Apple Silicon it installs `brew install llvm` when needed
  and automatically points Dr.Jit at Homebrew's keg-only `libLLVM.dylib`.
- **Linux x86-64 needs glibc 2.28+** (Ubuntu 20.04 and newer) for the Mitsuba
  wheel; arm64 needs 2.17+. Ubuntu 18.04 is too old to install at all.
- **Python 3.11–3.13**, and 3.14 works with one caveat. Every pinned wheel
  covers 3.9–3.14 except `numpy==2.2.6`, whose wheels stop at 3.13, so on a 3.14
  interpreter the requirements resolve numpy to 2.3.2+ instead. `setup.sh` picks
  the newest interpreter within the pinned range when the machine has one, and
  says so when it has to go above it. This matters on Ubuntu 26.04, whose
  default `python3` is 3.14.
- **`python3-venv`** is a separate Debian/Ubuntu package and is absent from
  fresh images, including WSL ones: `sudo apt update && sudo apt install
  python3-venv`. The `apt update` is not optional on a fresh image, or the
  package appears to have "no installation candidate".
- **Node.js 20+** — optional. If the machine has no Node, or one older than 20
  (Ubuntu 24.04's `apt install nodejs` still ships 18), `setup.sh` downloads a
  pinned Node into `./.node` automatically. No sudo, no system packages.

## Quick start

```bash
./setup.sh     # once: installs Node if needed + frontend deps + a Python venv with Sionna
./run.sh       # starts backend (:8000) + frontend (:3000); Ctrl+C stops both
```

(or `npm run setup` / `npm start`). Then open **http://localhost:3000**.
The header badge shows **RT-CORE ONLINE** when the backend is reachable.

Environment variables override the defaults:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `SRTS_PYTHON` | `./.venv/bin/python` | Point at an existing Python environment that already has Sionna, instead of the local venv. Read by `setup.sh` and `run.sh`. |
| `SRTS_BACKEND_PORT` | `8000` | Move the backend off port 8000 when something else holds it. Read by both `run.sh` and the Vite proxy, so the frontend follows automatically. |
| `SRTS_NODE_VERSION` | `22.23.1` | Which Node to fetch when `setup.sh` installs one into `./.node`. |
| `SRTS_NODE_INSTALL` | `auto` | Set to `off` to forbid the automatic Node download; `setup.sh` then fails if no Node 20+ is on `PATH`. |
| `DRJIT_LIBLLVM_PATH` | auto-detected on macOS | Override path to LLVM shared library. Normally unnecessary; `setup.sh`, `run.sh`, and direct backend startup detect Homebrew LLVM. |

```bash
SRTS_PYTHON=/path/to/venv/bin/python ./run.sh
SRTS_BACKEND_PORT=8011 ./run.sh
SRTS_NODE_INSTALL=off ./setup.sh
```

## Google Colab notebook support

SionnaRTStudio includes a dedicated launcher notebook: [`SionnaRTStudio_Colab_Launcher.ipynb`](SionnaRTStudio_Colab_Launcher.ipynb).

[Launch the notebook in Google Colab](https://colab.research.google.com/github/alexandarM/SionnaRTStudio/blob/main/SionnaRTStudio_Colab_Launcher.ipynb)

The notebook is preconfigured for [`alexandarM/SionnaRTStudio`](https://github.com/alexandarM/SionnaRTStudio) on the `main` branch. You can change the repository and branch in the first configuration cell when running a different fork.

The launcher is designed for a fresh Colab runtime and provides:

- Runtime and NVIDIA GPU detection, plus installation of required system packages.
- A configurable clone of this fork and its selected branch (it does not silently clone the upstream project).
- A Python virtual-environment check and a Colab-specific interpreter preference fix before invoking the repository's `setup.sh`.
- Setup logging, backend/frontend health checks, and a clickable Colab port-proxy link.
- Optional installation of the separate NR PHY dependency set for PUSCH BER/BLER experiments.
- Optional Google Drive persistence for the SQLite experiment database. Imported field-measurement datasets remain in memory and must be imported again after a backend/runtime restart.
- Optional test, TypeScript, and production-build checks after installation.

Open the notebook in Colab and review the repository and branch in the first configuration cell (preconfigured for `alexandarM/SionnaRTStudio` on `main`). Choose a GPU runtime if available, then execute the cells from top to bottom. A GPU is recommended for ray tracing; CPU/LLVM fallback may be considerably slower. Colab runtimes are temporary and are not a replacement for a persistent server.

The launcher uses the repository's installation and runtime scripts; it does not modify the upstream repository. Its only runtime compatibility adjustment is local to the Colab checkout and prioritizes a Python interpreter that has passed a virtual-environment/pip smoke test.

### Windows (WSL2)

There is no native Windows path — `setup.sh` / `run.sh` are bash and expect
`.venv/bin/`, not `.venv/Scripts/`. Run the project inside **WSL2**, which is
also the only Windows option that gives the guest a real GPU: unlike VirtualBox,
WSL2 passes an NVIDIA card straight through, so you get genuine CUDA ray tracing
rather than the CPU fallback.

```powershell
wsl --install -d Ubuntu     # in an admin PowerShell, then reboot
wsl -l -v                   # the VERSION column must read 2
```

> **WSL1 cannot run this project.** WSL1 translates Linux syscalls onto the NT
> kernel instead of running a real one, and Dr.Jit's native extension does not
> load there. The failure is confusing rather than obvious: `pip` installs every
> requirement successfully, then `import sionna` dies inside the native library.
> If `wsl -l -v` shows version 1, convert the distro and re-run `./setup.sh`:
>
> ```powershell
> wsl --set-default-version 2          # for distros installed later
> wsl --set-version Ubuntu-24.04 2     # for one already installed
> ```
>
> If `--set-version 2` fails, Windows itself lacks hardware virtualization. On a
> physical machine, enable Virtual Machine Platform and VT-x/AMD-V in firmware.
> When Windows is a VirtualBox guest, the host must expose nested virtualization
> (`VBoxManage modifyvm <vm> --nested-hw-virt on`).

Then, **in Windows** (not inside WSL), install the normal NVIDIA display driver.
That is the whole GPU setup — the driver exposes CUDA to the guest through
`/usr/lib/wsl/lib`, and no CUDA toolkit is needed.

> **Do not install a Linux NVIDIA driver inside WSL.** It overwrites the
> passthrough stubs and breaks GPU access. This is the most common way to end up
> with a WSL2 box that cannot see the card.

Inside the Ubuntu shell, confirm the GPU is visible, then set up as usual:

```bash
nvidia-smi                  # should list your card; if not, fix that first

# A fresh WSL image has no python3-venv, and setup.sh cannot build ./.venv
# without it. The index refresh is not optional on a new image — without it
# apt reports "Package 'python3-venv' has no installation candidate".
sudo apt update && sudo apt install -y python3-venv

git clone https://github.com/alexandarM/SionnaRTStudio.git
cd SionnaRTStudio
./setup.sh && ./run.sh
```

Open **http://localhost:3000** in the Windows browser — WSL2 forwards localhost
automatically, so no port configuration is needed.

Two things worth knowing:

- **Keep the checkout on the Linux filesystem** (`~/…`, not `/mnt/c/…`). Vite's
  file watching and npm installs are dramatically slower across the `/mnt/c`
  boundary.
- **No NVIDIA GPU?** WSL2 still works; it just runs the CPU variant, so install
  the LLVM runtime first: `sudo apt install llvm-runtime`.

### How Node is resolved

`setup.sh` and `run.sh` prefer `./.node/bin` over the system Node, so a
project-local install wins without touching anything outside this folder:

1. `./.node/bin/node`, if a previous `setup.sh` put one there.
2. Otherwise the system `node`, if it is v20 or newer.
3. Otherwise `setup.sh` downloads the official Node tarball for this
   platform, verifies it against the published `SHASUMS256.txt`, and unpacks it
   into `./.node`.

`.node/` is gitignored and adds ~200 MB. Delete it to fall back to the system
Node, or to force a re-download on the next `setup.sh`.

## Features

- **Google Colab launcher** — a dedicated notebook that clones the configured fork, prepares the Colab runtime, installs dependencies, checks backend/frontend health, exposes the UI through the Colab port proxy, and optionally persists experiment history on Google Drive. See [`SionnaRTStudio_Colab_Launcher.ipynb`](SionnaRTStudio_Colab_Launcher.ipynb).
- **GIS digital twin** — fetch building footprints, roads, parks, and water for any
  bounding box via the OpenStreetMap Overpass API; rendered as an interactive
  Three.js 3D scene with ITU radio materials per building.
- **Link analysis** — GPU ray tracing between any Tx/Rx pair: multipath rays in 3D,
  CIR taps, RX power, RMS delay spread, LOS/NLOS. Supports multiple transmitters
  and receivers with an all-pairs link matrix.
- **Beamforming** — configurable antenna array size, pattern (isotropic, dipole,
  half-wave dipole, 3GPP TR 38.901), polarization (V / H / VH / cross), and
  azimuth/elevation beamsteering that the solver genuinely applies.
- **Ray interaction control** — toggle line-of-sight, specular reflection, diffuse
  reflection, refraction, diffraction, and edge diffraction per solve
  (applies to links, mobility, and radio maps alike). PathSolver samples/source
  and seed are explicit, separately from radio-map Monte Carlo controls.
- **Radio coverage maps** — Sionna `RadioMapSolver` with best-server combining
  across transmitters; viridis/plasma/inferno/turbo colormaps with auto or
  manual vmin/vmax range. Monte Carlo rays/Tx and a deterministic seed are
  explicit controls and are returned with each grid for reproducibility.
- **On-demand Channel Analysis** — select up to 12 exact cells from a
  cached radio map (weak SINR, weak RSS, high interference, or manual indices),
  then run one batched `PathSolver` pass for serving/interfering sectors. Inspect
  per-link LOS/NLOS, paths, AoA/AoD, CIR taps, CFR magnitude/phase where defined,
  RMS delay spread, Doppler, and a ray-tracing K-factor estimate. The original
  map scene context is replayed and the Tx–Rx batch is bounded.
- **Spatial Association & Geolocation** — inspect an interactive
  2D Cell-to-TX association diagram (RSS serving, best SINR, best path gain,
  dominant interferer) with stable per-sector colours, TX markers and a legend.
  Click a cell to focus its marker in the 3D scene. Radio maps retain the WGS84
  anchor used at solve time; cells and weak-link candidates display latitude /
  longitude, offer Google Maps and clipboard actions, and export as geolocated
  CSV. Weak-cell sampling can be restricted to an RSS-serving or best-SINR
  sector footprint and use strict true Top-K or spatially distributed ranking.
- **Mobility (multi-transmitter)** — draw a receiver trajectory in the 3D scene (or
  generate a loop), then ray-trace **every transmitter** to each sampled position
  on the GPU (all Tx × all waypoints batched into one `PathSolver` dispatch). The
  API returns execution telemetry, and the UI visibly warns if the defensive serial
  fallback was used. Play it back: the receiver moves along the path while the rays
  from every transmitter, RX power, Doppler, delay spread, and LOS status update at
  every step, with a step scrubber and looping playback. A per-run **Best-server / Sum
  power** toggle picks how the multiple transmitters collapse into each step's KPIs:
  - **Best-server** — the single strongest Tx supplies the metrics and is highlighted
    as the serving cell, so you can inspect instantaneous **serving-cell
    transitions** as the receiver moves (no hysteresis or time-to-trigger is
    implied).
  - **Sum power** — non-coherently sums incident powers. It does not merge
    cross-transmitter delays/phases or invent a joint delay spread without an
    inter-cell synchronization model; per-Tx delay spreads remain available.

  Either way the scene renders the union of every transmitter's rays, and a per-Tx RSS
  / LOS breakdown is shown for each waypoint. Add transmitters right in the Trajectory
  panel; all Tx share one antenna array (matching `antennaArraySize` required).
- **A3 handover analysis** — on top of the instantaneous best-server association,
  the mobility solve runs the 3GPP A3 event model (hysteresis + time-to-trigger,
  honored in seconds via waypoint spacing and speed) over the per-Tx RSS series:
  serving-cell series, handover events (clickable — they jump the playback),
  ping-pong count, and the hysteresis-free switch count as the baseline.
- **Link-level KPIs (Shannon upper bound)** — one click re-traces the active
  link, samples `paths.cfr()` on a configurable OFDM grid and reduces it to
  open-loop/MRT/steered-beam capacity, spectral efficiency, effective rank,
  condition number, coherence bandwidth and link-budget SNR. The displayed
  rate is a Shannon/ideal upper bound, not scheduled NR throughput or achieved
  application goodput. Pure NumPy; no PHY package needed.
- **Field measurement import and quality control** — import raw Quectel logs or
  GPS-joined measurement CSVs, retain original records, flag modem sentinel values,
  filter by RAT/PCI/band, inspect RF statistics, and export reviewed datasets.
- **Geospatial alignment** — transform WGS84 measurement coordinates into the
  active scene's local ENU frame, calculate the selected metric CRS reference coordinates,
  check the scene envelope, and preserve the source rows in georeferenced exports.
- **Radio identity and transmitter matching** — group NR PCI/ARFCN and LTE-anchor
  contexts, compare sampled measurement bearings/distances with configured scene
  transmitters, and rank candidates without claiming an unverified serving-cell map.
- **Measurement-location ray tracing** — run downlink Sionna RT solves at sampled
  GPS measurement positions using the measured NR-ARFCN carrier frequency, then
  export per-location path and received-power diagnostics.
- **3D field-measurement overlay** — display grouped GPS locations, every individual
  measurement, or all imported GPS-tagged records. Inspect overlapping samples,
  filter by RAT/PCI/RSRP validity, and keep geographic coordinates unchanged.
- **RF configuration reproducibility** — capture the effective carrier, power
  reference, antenna/array, beam, solver, material, geometry and sample settings
  with a SHA-256 configuration fingerprint for each supported ray-tracing run.
- **Repeatable workflows** — preserve analysis-panel state when navigating between
  workspace sections, retain active job polling, and unlock request controls after
  success, failure or cancellation so supported calculations can be repeated.
- **NR FR1 PUSCH BER/BLER (optional)** — with Sionna PHY installed
  (`pip install -r backend/requirements-phy.txt`), a ray-traced CIR is replayed
  through the reciprocal single-link uplink PUSCH chain (LDPC TB, QAM, DMRS,
  default LS channel estimation and LMMSE detection). Configure supported FR1
  nominal channel bandwidth, SCS, MCS table/index, PCI, cyclic prefix and DMRS.
  BER/BLER include Wilson 95% intervals and achieved decoded-TB goodput is
  reported per simulated slot duration. The sweep normalizes the channel to
  unit mean energy and currently adds AWGN only: it excludes absolute RT path
  loss and inter-cell interference, and is not a full 5G system simulation.
  The PHY runs CPU-pinned so the GPU stays exclusive to the ray tracer.
- **CIR / CFR export** — re-run `PathSolver` for the active link or every Tx/Rx
  in one scene dispatch. Download raw `a, tau = paths.cir()` without an OFDM
  grid, or include `h = paths.cfr()` over configurable subcarriers. Multi-device
  NPZ files preserve Sionna's full receiver/antenna/transmitter tensor axes.
- **Standalone Sionna RT scene export** — download the exact Mitsuba scene the
  backend ray-traces (`scene.xml` with ITU radio-material BSDFs plus one `.ply`
  per building) alongside a generated `load_scene.py` that replays everything
  Sionna keeps in Python rather than in the XML: carrier frequency, material
  overrides, the `PlanarArray` config, every Tx/Rx, and the `PathSolver`
  switches. Run it in a plain notebook to reproduce a solve with no app in the
  loop.
- **Experiment Management & Reproducibility** — persistent SQLite Run History with timestamps, duration, RF snapshots, SHA-256 fingerprints, seeds, errors and results; reusable RF Configuration Presets; scalar Experiment Comparison; replay/retry; cooperative cancellation for NR PHY and sampled measurement ray-tracing jobs; and HTML Validation Reports that keep modem SS-RSRP distinct from Sionna RT total received power. The database defaults to `data/experiments.sqlite3`; set `SIONNA_RT_STUDIO_DATA_DIR` to mounted Google Drive storage in Colab to preserve it across runtime resets. See [`docs/EXPERIMENT_MANAGEMENT.md`](docs/EXPERIMENT_MANAGEMENT.md) for behavior and limits.
- **Project save / restore** — editable scene state autosaves in the browser. A
  versioned project JSON can also be exported and imported to move the complete
  geometry, Tx/Rx and antenna settings, solver/material controls, trajectory,
  coverage controls, and display choices between runs or computers. Computed
  rays and maps are deliberately regenerated after loading.
- **Scene & dataset export** — GeoJSON / Wavefront OBJ / propagation CSV scene exports,
  plus two clearly separated channel-grid paths: a coverage-derived JSON proxy
  whose `H` is synthesized from map power, and a backend `.npz` containing
  ray-traced per-cell MIMO CFR from `paths.cfr()` with the active Tx and Rx
  array-port axes. This is not a standardized third-party scenario package.

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Frontend (port 3000)      │  /api   │  Backend (port 8000)         │
│  React + Three.js + Vite   │ ──────► │  FastAPI + Sionna RT         │
│  src/                      │  proxy  │  backend/                    │
│  • 3D scene & map UI       │         │  • Mitsuba scene from OSM    │
│  • playback & charts       │         │    footprints (ENU meters)   │
│  • exporters (CIR/CFR…)    │         │  • PathSolver / RadioMap-    │
│                            │         │    Solver on CUDA            │
└────────────────────────────┘         └──────────────────────────────┘
```

The backend builds a Sionna/Mitsuba scene from the same ENU building footprints
the frontend renders (cached by geometry hash). The API therefore needs no
geodetic reprojection; the renderer maps ENU values into Three.js as
`(X, Y, Z) = (east, up, -north)`.

## City-scale preview streaming and LOD

The 3D preview progressively builds and displays disposable Three.js chunks around
the camera. Chunks are spatially grouped (250 m by default, 500 m for larger
scenes), loaded in distance/frustum order, and released from GPU memory when they
are far outside the active view. Their original OSM features remain in the project
data and can be rebuilt when the camera returns. Geometry preparation yields to
the browser between batches so camera controls and rendering can continue.

The preview uses three detail tiers:

- **Coarse** — simplified preview geometry (1.25 m for smaller scenes, 2 m for
  larger scenes); street labels, synthetic park trees, and outlines are omitted.
- **Medium** — 0.55 m preview simplification, used as the camera approaches a
  chunk.
- **High** — original, unsimplified OSM footprint points for nearby preview
  chunks. A hysteresis band avoids rebuilding geometry around LOD thresholds.

At most 18 refined (medium/high) chunks are kept resident; when a closer chunk
needs detail, the farthest refined chunk can be evicted and regenerated later.
The stream radius follows camera distance (bounded between 1 km and 400 km),
while frustum and feature bounds decide which chunks are relevant. The HUD
reports loaded chunks and refined chunks alongside the renderer counters.

**Simulation geometry is not simplified.** `BuildingFootprint` objects, original
ENU coordinates, heights, material settings, transmitter/receiver settings, and
all Sionna RT solver parameters are not modified by this preview pipeline. Only
the transient Three.js render meshes use the preview LOD tolerances. Rooftop
height queries continue to use original OSM building footprints.

The LOD policy is defined in `src/lib/previewLod.ts`; the streaming/build lifecycle
is in `src/components/ThreeStudio.tsx`. Run `npm run check:preview-lod` to check
the pure chunk/LOD policy helpers.

## Using it

1. **Geography** — pan the Leaflet map to an area and press
   **Fetch OSM Physical Twin** to download real buildings (or keep the preloaded
   demo city).
2. **Link Analysis** — place Tx/Rx (map drag, *Place TX/RX* in the 3D scene, or
   sliders), set frequency / max depth / ray interactions, press
   **Solve Link · Sionna RT**. With multiple devices, **Solve All Pairs** fills
   the link matrix; click a cell to focus that pair.
3. **Radio Coverage** — choose grid step and height, press
   **Map Coverage Matrix Grid**. Adjust the colormap and range under *Display*.
4. **Trajectory** (mobility) — add/select transmitters in the panel (**+ Add** under
   *Transmitters ray-traced to the path*), pick the **Best-server / Sum power** KPI
   mode, press **Draw Path** and click waypoints in the 3D scene, then **Run Mobility ·
   Sionna RT** (every transmitter is ray-traced to each sampled position, capped at
   100). Press **Play** to watch the receiver move with live per-position rays and
   metrics — including the serving Tx and a per-Tx RSS breakdown; drag the scrubber to
   inspect any step. With two or more transmitters, the **A3 handover** card sets
   hysteresis (0–15 dB) and time-to-trigger; after a run, handover events are listed
   and clicking one jumps the playback to that waypoint.
5. **Analysis** — after solving a link, **Compute KPIs** reduces its ray-traced CFR
   to Shannon-capacity upper-bound KPIs (not scheduled NR throughput), and — with
   the optional PHY package — configure FR1 bandwidth/SCS, MCS table/index, PCI,
   CP and DMRS before **Run BER Sweep**. The PUSCH experiment reports BER/BLER,
   confidence intervals and decoded-TB goodput for a normalized reciprocal
   single-link AWGN channel.
6. **Export** — use **Export Project** / **Import Project** for a reloadable
   SionnaRTStudio project, or download the scene (OBJ / GeoJSON), propagation
   report (CSV), channel response (CIR / CFR), or a ray-traced channel grid /
   explicitly labeled coverage proxy. **Scene + load_scene.py (.zip)** exports the
   ray-traced Mitsuba scene as a standalone Sionna RT project that runs outside
   the app. Editable project inputs also autosave in the current browser.

## NR PHY configuration and link-level experiment

The NR PHY Simulation module provides a configurable **FR1 PUSCH** experiment
over the ray-traced link. It is deliberately link-level: it does not implement
NAS, RRC, AKA, a 5G core, a scheduler, inter-cell PRB coordination or HARQ.

The selected nominal channel bandwidth and SCS are converted to a PRB count
using the FR1 bandwidth table in 3GPP TS 38.104 Table 5.3.2-1. This release
exposes 15, 30 and 60 kHz SCS combinations. For example, 20 MHz at 30 kHz
uses 51 PRBs / 612 active subcarriers; the occupied subcarrier bandwidth is
18.36 MHz inside the nominal 20 MHz channel. MCS tables 1–3, PCI, normal/
extended CP (extended only at 60 kHz) and PUSCH DMRS configuration are
explicit controls.

The app first ray-traces the BS-to-UE CIR, then uses reciprocity to construct a
single-stream UE-to-BS PUSCH channel. UE array ports are combined by a
unit-norm uniform precoder; every ray-path tap is retained. The default
`PUSCHReceiver` uses Sionna's LS channel estimation with linear interpolation
and LMMSE detection. A conservative maximum-excess-delay versus minimum-CP
comparison is displayed as a warning only; the current frequency-domain
`ApplyOFDMChannel` does not model ISI/ICI caused by a delay spread beyond CP.

The default **Normalized Eb/N0** mode normalizes the CIR-derived CFR to unit
average energy. Its Eb/N0 sweep isolates channel selectivity and excludes
absolute path loss. The optional **Absolute link budget** mode preserves the
unnormalized RT CFR and derives the noise reference from a separate UE conducted
Tx-power assumption, BS receiver noise figure, 293 K thermal noise and active
PUSCH occupied bandwidth. In absolute mode, a 0 dB link offset is the modeled
physical operating point; the displayed MCS-equivalent Eb/N0 baseline is an
approximation and is not a calibrated UE sensitivity result.

The UI supports 0.5, 1 and 2 dB sweep steps. Both modes remain single-link
reciprocal PUSCH with AWGN only; there is no inter-cell interference, uplink
power control, scheduler or HARQ. The reported goodput is decoded transport-
block bits divided by simulated slot time; it excludes upper-layer and network
overhead. Wilson score 95% intervals accompany BER/BLER to show finite-sample
uncertainty. The pre-existing Shannon-capacity panel remains a separate ideal
upper-bound calculation; it must not be interpreted as achieved NR throughput.
See [`docs/NR_PHY_CONFIGURATION_GUIDE.md`](docs/NR_PHY_CONFIGURATION_GUIDE.md),
[`docs/NR_ABSOLUTE_LINK_BUDGET_GUIDE.md`](docs/NR_ABSOLUTE_LINK_BUDGET_GUIDE.md),
[`ABSOLUTE_LINK_BUDGET_COLAB_TEST.md`](docs/testing/colab/ABSOLUTE_LINK_BUDGET_COLAB_TEST.md) and
[`NR_PHY_RELEASE_NOTES.md`](docs/releases/NR_PHY_RELEASE_NOTES.md) for assumptions, test steps
and validation status.

## Channel-response exports (CIR / CFR)

The **Export** tab can reproduce the standard Sionna notebook workflow directly
from the browser. The **CIR & CFR Export** card re-runs `PathSolver` for either
the active link or, with **Export all Tx × Rx as one scene tensor**, every
device in one dispatch:

| Output | Description |
| ------ | ----------- |
| `a` | Complex baseband path coefficients (channel impulse response) |
| `tau` | Path delays in seconds |
| `h_freq` | Channel frequency response over the OFDM subcarrier grid |
| `frequencies` | Baseband subcarrier offsets (Hz) |

The **Raw a, tau (.npz)** button does not build a subcarrier grid or evaluate
`paths.cfr()`. The combined NPZ uses the selected subcarrier count and spacing.
Both honor delay normalization (`tau_0 = 0`). Multi-device CSV is intentionally
disabled because flattening its device and antenna axes would be ambiguous.

If array sizes differ, the card offers **Export all-pairs ZIP** instead of
forcing heterogeneous devices into an invalid dense tensor. The backend
retraces every pair with its actual Tx/Rx arrays and writes `cir/*.npz` plus
`manifest.json`. The earlier **Solve All Pairs** matrix cannot be reused because
it retains display rays and KPIs, not the full complex CIR tensors.

The `.npz` loads straight into Python:

```python
import numpy as np
d = np.load("sionna_rt_studio_cir_cfr.npz")
a, tau, h = d["a"], d["tau"], d["h_freq"]   # CIR coeffs, delays [s], CFR
print(a.shape)   # [num_rx, num_rx_ant, num_tx, num_tx_ant, paths, time]
print(tau.shape) # [num_rx, num_rx_ant, num_tx, num_tx_ant, paths]
```

With synthetic arrays, Sionna internally shares geometric delays across antenna
ports. The export broadcasts `tau` over those antenna axes to match the tutorial
layout and also stores the unbroadcast native values as `tau_geometric`.
`tx_ids`, `rx_ids`, names, positions, array sizes, and device counts label the
tensor axes.

Single-link CIR and CFR CSV variants remain available for quick inspection.
This mirrors:

```python
p_solver = PathSolver()
paths = p_solver(scene, max_depth=...)
a, tau = paths.cir(normalize_delays=True)
h = paths.cfr(frequencies=subcarrier_frequencies(num_subcarriers, subcarrier_spacing))
```

See [`backend/README.md`](backend/README.md) for the full API reference.

## Standalone Sionna RT scene export

The **Export** tab's *Sionna RT Scene Export* card downloads the ray-tracing
scene as a self-contained Sionna RT project, so a solve can be reproduced with
no app in the loop. Every mesh reference in the XML is relative, so the
directory is relocatable as-is.

| Member | Contents |
| ------ | -------- |
| `scene.xml` | Mitsuba scene with ITU radio-material BSDFs and relative mesh paths |
| `meshes/*.ply` | Ground plane plus one extruded prism per building |
| `load_scene.py` | Replays the Python-side setup Sionna keeps out of the XML |
| `manifest.json` | The exact settings this export was generated from |
| `README.md` | Usage notes for the bundle itself |

The XML cannot carry what Sionna holds on the Python side, which is why the
generated script exists. It replays the carrier frequency, radio-material
overrides, the `PlanarArray` configuration, every transmitter/receiver (with
each Tx's configured `power_dbm`), and the `PathSolver` interaction switches,
ending in `paths.cir()` / `paths.cfr()`:

```bash
pip install sionna-rt
python load_scene.py       # writes cir.npz next to the script
```

For a uniform-array scene the script writes a single `cir.npz`. When device
array sizes differ, one dense tensor is impossible — a Sionna scene has one
shared Tx array and one shared Rx array — so the script groups devices by exact
array-size pair and writes one tensor per compatible combination under
`channels/`, with `manifest.json` mapping each group to its file. Together they
cover every Tx×Rx pair without padding or replacing any antenna array.

Coordinates are ENU metres (x=East, y=North, z=Up) with the ground plane at
z=0, matching the rest of the app. Device heights are roof-aware: a device over
a building footprint sits on it.

## Freezing an OSM scene

The live map selector accepts a custom square selection size in metres with no
fixed upper UI limit. Selections are split into bounded Overpass request tiles
(2.5 km target side) and fetched sequentially through the FastAPI
`POST /api/osm/query` same-origin proxy. The backend adds an identifiable
User-Agent, tries the documented global instances in sequence, rate-spaces
requests, and returns typed errors. HTTP 502/503/504 and network timeouts are
treated as upstream capacity failures: the same tile is retried once rather
than creating more requests by subdivision. Smaller tiles are used only when
Overpass explicitly reports a query timeout or memory/resource limit. Results
are deduplicated by OSM element type/id before the shared parser runs. This does
not bypass public Overpass capacity/rate limits; for repeatable whole-city or
country-scale workloads, use a regional OSM PBF extract or a dedicated service.

For the 3D preview, the browser derives disposable chunked BufferGeometry from
the original OSM features. Preview vertex simplification, material batching,
tree instancing and street-label distance culling do not modify the source
`BuildingFootprint` data used by the backend/Sionna RT scene.

Both the browser and freezer call `src/utils.ts::parseOsmElements`:

```bash
npm run check:osm-parser
npm run freeze:osm-scene
```

The freezer writes the raw Overpass payload, all visual features, backend-ready
buildings, and `osm_scene_manifest.json` with the query, bounds, counts, runtime,
and SHA-256 hashes under `artifacts/osm-scene/` by default. Use `--out-dir` to
choose another destination. Re-run it only when intentionally creating a new
dated scene snapshot; experiments should cite the frozen hashes.

## Testing and validation

The project combines automated backend regression tests, focused frontend checks, and manual end-to-end acceptance procedures.

Run the backend checks from the repository root:

```bash
python -m compileall -q backend
python -m pytest -q backend/tests
bash -n setup.sh
bash -n run.sh
bash -n scripts/runtime-env.sh
```

After installing frontend dependencies, run:

```bash
npm run lint
npm run build
```

Focused browser/utility checks are available through the scripts and npm commands declared in `package.json` (including OSM parser, georeference, measurement overlay, panel lifecycle, and preview/LOD checks).

Manual Google Colab acceptance procedures are collected in [`docs/testing/colab/`](docs/testing/colab/). See [`docs/testing/README.md`](docs/testing/README.md) for the complete test matrix and privacy guidance.

Automated tests do not replace live Colab validation. GPU/Mitsuba PathSolver and optional NR PHY workflows must be exercised in a compatible runtime before claiming end-to-end acceptance. Test fixtures are synthetic; private field datasets and routes are not included in this repository.

## Troubleshooting

**`RT-CORE ONLINE` never appears / requests fail.** The backend is unreachable.
Confirm it is up and check which port it took: `curl localhost:8000/api/health`.
If something else already holds 8000, restart with `SRTS_BACKEND_PORT=8011
./run.sh` — the Vite proxy reads the same variable, so the frontend follows.

**WSL2: `/api/health` reports `"gpu": false` even though the machine has an
NVIDIA card.** Run `nvidia-smi` inside the WSL shell. If it fails there but
works in Windows, the passthrough is broken — almost always because a Linux
NVIDIA driver was installed inside WSL, which overwrites the stub libraries in
`/usr/lib/wsl/lib`. Only the Windows-side driver should ever be installed.
Failing that, `wsl --update` and restart with `wsl --shutdown`.

**`run.sh` says the Python cannot import sionna/fastapi, but `pip` reports
everything already satisfied.** The packages really are installed. `import
sionna` loads Dr.Jit's native extension, so the import fails for a reason that
has nothing to do with the package set. Read the traceback `run.sh` prints. Two
causes account for nearly all of these: the distro is WSL1 rather than WSL2
(check `wsl -l -v` in PowerShell, see [Windows (WSL2)](#windows-wsl2)), or the
LLVM runtime is missing on a machine with no CUDA GPU (Ubuntu: `sudo apt install
llvm-runtime`; macOS: `brew install llvm`). A `setup.sh` run that ended in
"Mitsuba could not be imported" rather than a variant line points at the same
problem.

**`setup.sh` fails installing numpy with "Unknown compiler(s)" or "Preparing
metadata (pyproject.toml) did not run successfully".** pip found no prebuilt
wheel for this interpreter and fell back to compiling from source, which needs a
C toolchain the machine does not have. The usual cause is a Python newer than
the pinned wheel set, such as Ubuntu 26.04's default 3.14 against
`numpy==2.2.6`. Install a Python 3.11–3.13 with its matching `-venv` package and
re-run `setup.sh`, which prefers it automatically. Adding a compiler
(`sudo apt install build-essential`) also works but builds numpy from source for
several minutes.

**Backend refuses to start: "No usable Mitsuba variant".** The machine has no
CUDA GPU *and* no LLVM runtime for the CPU fallback. On Ubuntu, run `sudo apt
install llvm-runtime`. On Apple Silicon, re-run `./setup.sh`: it installs LLVM
through Homebrew and resolves the keg-only `libLLVM.dylib` automatically. A
manual override remains available: `DRJIT_LIBLLVM_PATH="$(brew --prefix
llvm)/lib/libLLVM.dylib" ./run.sh`.

**The web UI loads but the badge stays `RT-CORE OFFLINE`.** Vite and the backend
are separate processes — `run.sh` starts uvicorn in the background and the
frontend in the foreground, so the page serves fine even when the backend died
on startup. Look at the `run.sh` output for a Python traceback, or hit
`curl localhost:8000/api/health` directly to see the real error. Nothing about a
blank badge is a frontend problem.

**Solves are slow, and `/api/health` reports `"gpu": false`.** Rays are being
traced on the CPU. Startup prefers `cuda_ad_mono_polarized` and falls back to
`llvm_ad_mono_polarized` whenever CUDA cannot initialize, logging
`[startup] WARNING: no CUDA GPU`. Results are identical either way — only the
speed differs. Common causes: running inside a VM (VirtualBox and friends give
the guest no access to the host GPU without passthrough, so this is expected and
unavoidable there), no NVIDIA card, or a driver/library mismatch — check whether
`nvidia-smi` runs at all, and reinstall `mitsuba` against a working CUDA toolkit
if it does.

**Rays pass straight through buildings.** Almost always a missing
`mapbox_earcut` — trimesh cannot triangulate the footprints, so buildings never
mesh and drop out of the ray-traced scene entirely. The browser gives no hint,
but the backend log does: look for `[scene_build] WARNING: failed to extrude
building`. Fix with `pip install mapbox_earcut` (it is in
`backend/requirements.txt` for exactly this reason).

**Fetching OSM fails.** The browser calls the local FastAPI `POST /api/osm/query`
endpoint; the Colab backend contacts the global Overpass instances in this
order: `maps.mail.ru`, `overpass.private.coffee`, then `overpass-api.de`. The
backend sends an identifiable User-Agent, serializes upstream requests, checks
both HTTP errors and HTTP 200 `remark` fields, and caches successful tiles for
30 minutes during the current runtime. Capacity errors (including a 502 saying
all query workers are busy) and network timeouts do not trigger subdivision:
the same tile is retried once after a cooldown. A tile is subdivided only when
all providers explicitly report a query timeout or memory/resource limit. The
obsolete `z.overpass-api.de` endpoint is excluded. Public instances remain
shared infrastructure and can all be busy; for repeatable city-scale or
country-scale downloads, use a regional OSM PBF extract or a dedicated
Overpass service instead of repeatedly querying shared public infrastructure.

**`Run BER Sweep` is unavailable.** The Sionna PHY package is optional and not
installed by `setup.sh`. `/api/health` reports it as `"phy"`. Install with
`pip install -r backend/requirements-phy.txt` (~4 GB with torch). A second
concurrent sweep returns `409` — only one job runs at a time.

**Frontend changes do not appear.** Hard-refresh the tab; Vite's cached module
graph survives an ordinary reload.

**`setup.sh` cannot download Node.** It needs `curl` or `wget`, plus `tar` and
`xz`, and prints which one is missing — on a minimal Ubuntu image install them
with `sudo apt install curl xz-utils`. Behind a proxy or with no network, get
Node 20+ onto `PATH` yourself and re-run with `SRTS_NODE_INSTALL=off ./setup.sh`
to skip the download entirely. Automatic install covers Linux and macOS on
x86-64 and arm64; anywhere else it stops and asks you to install Node manually.

## Notes

- Only `category:"building"` footprints are ray-traced (a ground plane is added
  automatically); roads/parks/water are visual-only.
- Multipolygon outer rings are preserved; interior courtyard rings are not yet
  represented by the current simple footprint schema.
- Diffuse reflection and refraction add many ray branches — expect slower solves,
  especially on radio maps.
- Tx and Rx arrays are physical Sionna `PlanarArray` objects with configurable
  size, pattern, and polarization. PathSolver uses synthetic arrays (device-center
  tracing plus Sionna's per-port phase application); scalar RSS sums the resulting
  Rx-port powers rather than adding an analytic `10·log10(Nr)` term.
- Sionna `RadioMapSolver` uses its own ideal dual-polarized isotropic receiver,
  so configured Rx arrays apply to links, mobility, CIR/CFR, link KPIs, PHY
  replay, and ray-traced channel-grid export—not to the coverage heatmap.
- Link/mobility channel KPIs (total power, RMS delay spread, path count) are
  computed over the **full** Sionna path set; only the rays drawn in the 3D view
  are capped (to the 15 strongest) for legibility.
- **Refraction** is approximate for solid structures. Sionna RT models each surface
  as a flat slab and folds wall thickness into the transmission coefficient;
  buildings here are closed prisms, so a transmitted ray crosses two wall slabs
  (entry + exit), each costing a `max_depth` bounce. Reflection and LOS occlusion
  are unaffected.
- The radio map's per-cell **LOS flag** is a 2D-footprint geometric approximation
  (Sionna's `RadioMapSolver` returns path gain / RSS / SINR, not per-cell LOS), so
  treat it as a hint, not ground truth.

## Fork origin and attribution

This repository is the public fork [`alexandarM/SionnaRTStudio`](https://github.com/alexandarM/SionnaRTStudio), derived from [SionnaRTStudio by Pulok Tarafder](https://github.com/puloktarafder/SionnaRTStudio). GitHub records the fork relationship to the upstream repository. The upstream project established the original browser-based wireless digital-twin application and its Sionna RT integration. The original author, upstream license, copyright notices, and attribution records are retained.

This fork extends the upstream application with additional research workflows, including field-measurement quality control and geospatial alignment, radio-identity/transmitter candidate matching, ray tracing at measurement locations, 3D measurement overlays, RF configuration fingerprints, repeatable workflows, experiment history/presets/comparison, and validation-report generation. It also includes a dedicated Google Colab launcher notebook and Colab-specific setup guidance.

The fork-specific additions should not be attributed to the upstream author unless they are incorporated upstream. Likewise, this repository does not claim authorship of the original SionnaRTStudio code. See [`FORK_AND_ATTRIBUTION.md`](FORK_AND_ATTRIBUTION.md) for the source project, scope of changes, and citation guidance.

## Citation

The DOI and [`CITATION.cff`](CITATION.cff) below identify the original upstream SionnaRTStudio release by Pulok Tarafder; they do not archive or describe the fork-specific additions in this repository. Cite the upstream release when referring to the original application:

> [1] P. Tarafder, *SionnaRTStudio: A Browser-Based Wireless Digital Twin*,
> version 1.0.0. Zenodo, Aug. 23, 2026.
> doi: [10.5281/zenodo.22064926](https://doi.org/10.5281/zenodo.22064926).


```bibtex
@misc{tarafder2026sionnartstudio,
  author       = {Tarafder, Pulok},
  title        = {{SionnaRTStudio}: A Browser-Based Wireless Digital Twin
                  (v1.0.0)},
  howpublished = {Zenodo},
  month        = aug,
  year         = {2026},
  note         = {doi: 10.5281/zenodo.22064926},
  url          = {https://doi.org/10.5281/zenodo.22064926}
}
```

Machine-readable metadata for the upstream release is available in [`CITATION.cff`](CITATION.cff). For work that depends on this fork, also cite the exact fork URL and commit or release tag; create a DOI for this fork if a separately archived release is needed.

## License

Apache-2.0. See [NOTICE](NOTICE) for third-party notices. Map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Sionna RT
is © NVIDIA Corporation (Apache-2.0).


## Radio-map performance notes

The coverage map is computed by Sionna RT's `RadioMapSolver`. Per-cell LOS is
not provided by that solver, so the API marks it as unknown rather than running
a costly footprint-based LOS approximation for every map cell. Stage timing
logs are emitted by the backend under the `[radiomap]` and `[radiomap-api]`
prefixes. See `docs/RADIO_MAP_PERFORMANCE.md` for diagnosis and Colab log
interpretation.

## Preview LOD toggle (city-scale viewport)

The 3D viewport toolbar has an independent **LOD On / Full Detail** control.

- **LOD On** (default) applies distance-based preview simplification and keeps
  the near-camera medium/high preview tiers bounded in GPU memory.
- **Full Detail** disables preview simplification for chunks as they are loaded.
  Progressive chunk streaming and off-screen chunk eviction remain active to
  avoid forcing an entire city into browser/GPU memory at once.
- The existing **High / Eco** control changes renderer quality (shadow pass and
  pixel ratio); it is independent of LOD.

For screenshots, select **Full Detail** and **High**, then wait for the HUD's
`Loading` indicator to disappear. Full Detail can use considerably more GPU and
browser memory. These controls affect only the Three.js preview and do not alter
OSM source geometry or Sionna RT simulation inputs.


## Base-station inventory import (CSV / XLSX)

The left-side **Import Base Stations** panel accepts a private CSV, TSV or XLSX inventory. The file is parsed locally in the browser; the original spreadsheet file is not uploaded to the backend. Each non-empty data row becomes one transmitter/sector and retains `Site`, transmitter label, antenna model, frequency-band text, longitude, latitude, height, azimuth, downtilt and source power metadata.

The importer expects these column headings (case-insensitive aliases are supported): `Site`, `Transmitter`, `Antenna`, `Longitude`, `Latitude`, `Height (m)`, `Azimuth (°)`, `Mechanical Downtilt`, `Power (dBm)` and `Frequency Band`. A separate exact `Carrier Frequency (GHz/MHz)`, `Center Frequency` or `Downlink Frequency` column is optional. Rows with missing/invalid required coordinates or values are rejected with row numbers; they are not silently skipped.

Before import, choose the vertical height datum (`AGL`, above-roof, or absolute local scene Z) and clarify whether the source power column is conducted TX power or EIRP. EIRP can be converted to conducted power only when antenna gain is provided. The current flat-ground scene assumes local ground Z=0 for AGL. The antenna model and band labels are preserved as metadata; they do not silently select a vendor radiation pattern. The currently selected TX antenna pattern in RF Controls remains the Sionna scene pattern.

The geographic coordinates are transformed using the same local ENU anchor conversion as OSM building footprints, so imported sites and the OSM scene share one coordinate frame. Before importing, recenter the map anchor on the same area as the stations/OSM scene; the UI blocks import if the farthest station is more than 100 km from the current anchor. The starter project anchor is only a demo location and should not be reused for a different study area. The importer does not reproject to a different CRS independently.

**Frequency integrity:** values such as `n78`, `GSM 900`, or a nominal frequency printed inside a band label are not treated as the deployed carrier centre. When no exact carrier-frequency column is supplied, select a single Frequency Band group, set its actual downlink carrier in RF Controls, and change/confirm that value before running a radio map. RadioMapSolver uses one carrier frequency for a scene; different bands/carriers must not be combined as co-channel interferers.

The 3D preview draws all imported transmitter rows, with site/sector labels where practical. These markers are schematic visualisations of position and boresight, not calibrated vendor antenna radiation patterns.
