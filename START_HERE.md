# SionnaRTStudio — 3D Wireless Digital Twin and Research Platform

SionnaRTStudio is a browser-based research environment built around NVIDIA Sionna RT. It combines an interactive 3D scene, GPU ray tracing, radio coverage and channel analysis, NR PHY link-level experiments, field-measurement processing, and experiment management.

This is the public fork [alexandarM/SionnaRTStudio](https://github.com/alexandarM/SionnaRTStudio), derived from [SionnaRTStudio by Pulok Tarafder](https://github.com/puloktarafder/SionnaRTStudio). The upstream project and its original author remain credited. See [`FORK_AND_ATTRIBUTION.md`](FORK_AND_ATTRIBUTION.md) for attribution and citation guidance.

## Recommended: launch with Google Colab

Use the included [`SionnaRTStudio_Colab_Launcher.ipynb`](SionnaRTStudio_Colab_Launcher.ipynb).

1. Open the notebook in Google Colab.
2. In **Repository configuration**, the repository is already configured as `alexandarM/SionnaRTStudio` on the `main` branch. Change it only if you intentionally want to launch another fork or branch.
3. Select **Runtime → Change runtime type → GPU** when an NVIDIA GPU is available. CPU/LLVM fallback may work but can be significantly slower.
4. Run the notebook cells from top to bottom. The launcher checks the runtime, installs system packages, clones the configured fork, prepares a virtual environment, runs `setup.sh`, performs selected checks, starts the backend and frontend, and displays the Colab proxy link.
5. Import an OpenStreetMap scene and, when needed, load field-measurement CSV files in the application.

The notebook can optionally mount Google Drive and store the SQLite experiment database in a persistent Drive folder. This keeps experiment history and configuration presets across runtime resets. Imported field-measurement datasets are currently held in memory and must be imported again after a backend restart.

The NR PHY dependency set is optional and separate. Enable `INSTALL_OPTIONAL_PHY` in the notebook only when you need the NR PUSCH BER/BLER workflow; the package set is large and requires additional disk space.

Colab runtimes are temporary. The notebook starts the application for the active session; it does not provide permanent hosting or application authentication.

## Run locally

On a supported Linux, macOS, or Windows WSL2 environment:

```bash
./setup.sh
./run.sh
```

Then open `http://localhost:3000`. See [`README.md`](README.md) for system requirements, environment variables, troubleshooting, architecture, and detailed usage.

## Main capabilities

- 3D scene construction from OpenStreetMap data and transmitter/receiver placement.
- Sionna RT propagation, radio maps, channel analysis, mobility, and handover analysis.
- NR FR1 PUSCH BER/BLER link-level experiments (optional PHY dependencies).
- Field-measurement import, quality control, geospatial alignment, radio-identity matching, and measurement-location ray tracing.
- 3D measurement overlays with grouped, individual, and all-record display modes.
- RF configuration snapshots, repeatable workflows, SQLite experiment history, configuration presets, experiment comparison, supported cancellation/retry, and HTML validation reports.

## Important scientific distinctions

- Total Sionna RT received power is not automatically equivalent to modem SS-RSRP or CSI-RSRP. A like-for-like reference-signal model and RF calibration are required before calculating validation error metrics.
- Radio-identity matching ranks candidates; it does not prove which physical site served a measurement.
- GPS altitude is not used as scene height unless its vertical datum is verified.
- The rectangular scene envelope is a coarse spatial check, not point-in-mesh validation.
- NR PHY results are link-level experiments, not a complete 5G network simulation.

## Documentation

- [`README.md`](README.md) — full overview, installation, usage, architecture, tests, and troubleshooting.
- [`SionnaRTStudio_Colab_Launcher.ipynb`](SionnaRTStudio_Colab_Launcher.ipynb) — interactive Colab launcher.
- [`docs/GOOGLE_COLAB_LAUNCHER.md`](docs/GOOGLE_COLAB_LAUNCHER.md) — launcher setup and persistence details.
- [`FORK_AND_ATTRIBUTION.md`](FORK_AND_ATTRIBUTION.md) — upstream origin, fork-specific additions, and citation guidance.
- [`GITHUB_PUBLISHING_CHECKLIST.md`](GITHUB_PUBLISHING_CHECKLIST.md) — safe steps for applying this release to the existing GitHub fork and publishing it.
- [`docs/`](docs/) — detailed guides for radio coverage, channel analysis, field measurements, geospatial alignment, NR PHY, ray tracing, reproducibility, overlays, and experiment management.


## Testing

See [`docs/testing/README.md`](docs/testing/README.md) for automated checks, Colab acceptance procedures, and guidance for using anonymized test data.
