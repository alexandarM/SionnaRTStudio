# Testing and Validation

SionnaRTStudio uses two complementary validation layers:

1. **Automated tests** validate backend logic and selected frontend/runtime utilities.
2. **Manual acceptance procedures** validate end-to-end behavior in a browser or Google Colab runtime, including GPU-dependent Sionna RT/PHY workflows.

## Automated checks

From the repository root:

```bash
python -m compileall -q backend
python -m pytest -q backend/tests
bash -n setup.sh
bash -n run.sh
bash -n scripts/runtime-env.sh
npm ci
npm run lint
npm run build
```

Some focused TypeScript/Node checks are available through `package.json` scripts, including OSM parser, georeference, measurement overlay, panel lifecycle, and preview/LOD checks. Run the relevant script after installing frontend dependencies.

## Google Colab acceptance tests

The [`colab/`](colab/) directory contains manual acceptance procedures for:

| Procedure | Coverage |
|---|---|
| [Field Measurement Import & QC](colab/FIELD_MEASUREMENT_IMPORT_QC_COLAB_TEST.md) | CSV import, validation, filtering, export, and memory lifecycle |
| [Geospatial Alignment](colab/GEOSPATIAL_ALIGNMENT_COLAB_TEST.md) | WGS84-to-ENU conversion, scene envelope, and georeferenced export |
| [3D Measurement Display Modes](colab/3D_MEASUREMENT_DISPLAY_MODES_COLAB_TEST.md) | Grouped, individual, and all-record overlays |
| [Radio Identity Matching](colab/RADIO_IDENTITY_MATCHING_COLAB_TEST.md) | Radio profile construction and TX candidate review |
| [Measurement-Location Ray Tracing](colab/MEASUREMENT_LOCATION_RAYTRACING_COLAB_TEST.md) | Sampled Sionna RT execution and result interpretation |
| [RF Configuration Reproducibility](colab/RF_CONFIG_REPRODUCIBILITY_COLAB_TEST.md) | Configuration snapshots, fingerprints, and repeatability |
| [Repeatable Workflows](colab/REPEATABLE_WORKFLOWS_COLAB_TEST.md) | State preservation and repeatable UI actions |
| [NR PHY](colab/NR_PHY_COLAB_TEST.md) | Optional NR PHY runtime acceptance |
| [Absolute Link Budget](colab/ABSOLUTE_LINK_BUDGET_COLAB_TEST.md) | Absolute link-budget and fine Eb/N0 sweep behavior |
| [Experiment Management](colab/EXPERIMENT_MANAGEMENT_COLAB_TEST.md) | Run history, presets, comparison, persistence, and replay |

## Privacy and test data policy

No private field-measurement dataset, GPS track, route map, exact field coordinate range, or site/transmitter inventory is intentionally included in this repository. Test fixtures use synthetic values. Use synthetic, public, or anonymized data when reproducing acceptance tests.

Before opening a public issue or pull request, inspect screenshots, logs, CSVs, notebook outputs, and example configurations. Remove exact coordinates, route geometry, timestamps that reveal a private field campaign, device identifiers (such as IMEI/IMSI), and non-public radio/transmitter identifiers. Do not commit raw modem exports, GPS tracks, unredacted georeferenced CSV files, or private base-station inventory spreadsheets.

Expected row/marker counts and coordinate bounds are dataset-dependent. Acceptance procedures therefore verify invariants and consistency with the currently loaded dataset rather than publishing private reference counts.

## Reporting results

For each acceptance procedure, record:

- commit hash and application version;
- Colab runtime type and relevant Python/Node/Sionna/Mitsuba versions;
- test step and pass/fail result;
- sanitized error messages and anonymized counts;
- whether GPU-dependent solver execution was performed.

Do not claim a live Colab/GPU acceptance test from a successful unit-test run alone.
