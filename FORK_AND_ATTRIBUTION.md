# Fork Origin, Attribution, and Citation

## Upstream project

This repository is the public fork [`alexandarM/SionnaRTStudio`](https://github.com/alexandarM/SionnaRTStudio), derived from **SionnaRTStudio**, originally created by **Pulok Tarafder**:

- This fork: https://github.com/alexandarM/SionnaRTStudio
- Upstream repository: https://github.com/puloktarafder/SionnaRTStudio
- Upstream project DOI: https://doi.org/10.5281/zenodo.22064926
- Upstream license: Apache License 2.0

The original `LICENSE`, `NOTICE`, `CITATION.cff`, and upstream attribution are retained. This fork does not claim ownership or authorship of the original upstream implementation.

## Fork-specific scope

This fork adds or extends research and workflow capabilities on top of the upstream project, including:

- Field-measurement import, quality control, and geospatial alignment.
- Radio identity grouping and candidate transmitter matching.
- Downlink ray tracing at georeferenced measurement locations.
- 3D field-measurement overlays, including grouped, per-record, and all-imported-record modes.
- RF configuration snapshots and SHA-256 reproducibility fingerprints.
- Repeatable panel workflows and experiment-state handling.
- 5G NR PUSCH BER/BLER link-level simulation and absolute link-budget workflows.
- Experiment Management: SQLite Run History, Configuration Presets, Experiment Comparison, automatic result logging, supported Cancel/Retry workflows, and HTML validation reports.
- Google Colab launcher notebook and Colab-specific setup, health checks, logging, and optional Google Drive persistence for the experiment database.

The list describes the scope of this fork; it is not a claim that every dependency, underlying algorithm, or upstream subsystem was authored by the fork maintainer.

## Citation guidance

When citing the original SionnaRTStudio application or its upstream design, cite Pulok Tarafder's archived release using the DOI in `CITATION.cff`.

When research relies on additions made in this fork, cite both:

1. The upstream SionnaRTStudio release; and
2. This fork's GitHub repository URL together with the exact commit hash or release tag used.

The `CITATION.cff` currently retained in this repository describes the upstream release. It is intentionally not rewritten to imply that the upstream DOI identifies this fork. A separate archival DOI and fork-specific citation metadata should be created when this fork receives its own tagged software release.

## License and notices

The upstream Apache License 2.0 text is retained in `LICENSE`, and the original attribution notices are retained in `NOTICE`. Redistribution of this derivative work must continue to comply with Apache License 2.0, including preservation of applicable notices and the license text. In particular, Section 4(b) requires prominent notices in files that have been modified from upstream stating that those files were changed. Repository-level attribution in this document, the README, or `NOTICE` does not replace those per-file notices. Use `GITHUB_PUBLISHING_CHECKLIST.md` to identify modified files against the original Git baseline before publishing. See the official license: https://www.apache.org/licenses/LICENSE-2.0.

## Updating from upstream

The fork remains connected to the upstream repository through GitHub. To inspect upstream changes locally, add the upstream remote once and fetch it:

```bash
git remote add upstream https://github.com/puloktarafder/SionnaRTStudio.git
git fetch upstream
git remote -v
```

Review upstream changes before merging or rebasing. Because this fork contains substantial application changes, do not merge upstream blindly; resolve conflicts and rerun the full test suite.
