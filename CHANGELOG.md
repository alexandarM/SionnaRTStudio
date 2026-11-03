# Changelog

This file summarizes fork-specific work. Detailed implementation notes and historical validation records are maintained in [`docs/releases/`](docs/releases/). The upstream project's original history remains in the upstream repository.

## Current fork release — Google Colab and research workflow expansion

- Added a dedicated Google Colab launcher configured for `alexandarM/SionnaRTStudio`.
- Added Colab runtime setup, backend/frontend health checks, log access, optional NR PHY installation, and optional Google Drive persistence for the SQLite experiment database.
- Expanded field-measurement import and QC, geospatial alignment, radio identity review, measurement-location ray tracing, 3D overlays, RF configuration snapshots, reproducibility fingerprints, experiment management, and repeatable workflows.
- Added automated backend regression coverage and manual Colab acceptance procedures.
- Kept private measurement files, field routes, coordinate bounds, and site-specific identifiers out of the public repository documentation and test fixtures.

## Feature notes

- [Field Measurement Import & Quality Control](docs/releases/FIELD_MEASUREMENT_IMPORT_QC_RELEASE_NOTES.md)
- [Geospatial Alignment](docs/releases/GEOSPATIAL_ALIGNMENT_RELEASE_NOTES.md)
- [Spatial Association and Geolocation](docs/releases/SPATIAL_ASSOCIATION_RELEASE_NOTES.md)
- [Radio Identity & Transmitter Matching](docs/releases/RADIO_IDENTITY_MATCHING_RELEASE_NOTES.md)
- [Measurement-Location Ray Tracing](docs/releases/MEASUREMENT_LOCATION_RAYTRACING_RELEASE_NOTES.md)
- [3D Measurement Display Modes](docs/releases/3D_MEASUREMENT_DISPLAY_MODES_RELEASE_NOTES.md)
- [RF Configuration & Reproducibility](docs/releases/RF_CONFIG_REPRODUCIBILITY_RELEASE_NOTES.md)
- [NR PHY](docs/releases/NR_PHY_RELEASE_NOTES.md)
- [Experiment Management](docs/releases/EXPERIMENT_MANAGEMENT_RELEASE_NOTES.md)
- [Repeatable Workflows](docs/releases/REPEATABLE_WORKFLOWS_RELEASE_NOTES.md)
- [Channel Analysis](docs/releases/CHANNEL_ANALYSIS_RELEASE_NOTES.md)
- [Radio Coverage](docs/releases/RADIO_COVERAGE_RELEASE_NOTES.md)
