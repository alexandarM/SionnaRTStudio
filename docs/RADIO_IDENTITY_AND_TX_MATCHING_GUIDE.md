# Radio Identity & Transmitter Matching Guide

## Purpose

This module audits radio identity contexts between measurement import/geospatial alignment and a later ray-tracing stage. It does not itself run Sionna RT at measurement points or calculate measured-versus-simulated error metrics.

## What is implemented

- Profiles imported records by RAT, PCI, band, ARFCN, and observed LTE-anchor context.
- Reports sample counts, valid RF/GPS counts, distinct GPS positions, RF summaries, and time ranges.
- For NR NSA records, separately reports LTE anchor `cell_id`, LTE PCI, and EARFCN.
- Converts selected profile positions to the active Studio local ENU frame.
- Compares measurement positions with active scene transmitters.
- Reports median/P90 TX-to-measurement distance, average bearing to the measurement point cloud, antenna boresight, and angular difference.
- Compares the measurement band with explicitly supplied TX `frequencyBand` metadata when available.
- Marks prior results stale if the active anchor, scene envelope, TX positions, or beam azimuths change.

## Interpreting NR NSA identity fields

In NR5G-NSA measurement exports, LTE serving-cell fields and NR measurement fields can appear in related records. The application therefore labels `cell_id` and `earfcn` as **LTE anchor context** when that is their provenance, not as an NR gNodeB global identity.

PCI is not a globally unique site or sector identifier. Multiple identity contexts do not prove that there are the same number of physical NR sites or sectors. Interpret every profile using the source schema, network metadata, and independently reviewed transmitter inventory.

## TX candidate ranking

Candidates are sorted heuristically using:

1. Explicit frequency-band metadata match (match before unknown before mismatch).
2. Difference between the mean bearing from TX to selected measurements and the TX beam azimuth.
3. Median geometric distance.

The table is a **review aid only**. It is not a serving-cell identity algorithm, does not fully simulate antenna patterns, and does not automatically assign a PCI to a transmitter.

## What is deliberately not done

- No automatic PCI-to-gNodeB/site assignment.
- No inference of NR global cell identity from LTE anchor `cell_id`.
- No Sionna RT PathSolver execution at measurement points in this module.
- No comparison of modem SS-RSRP to Sionna total received power.
- No RMSE, MAE, or bias calculation.
- No invented GPS Z coordinate; vertical datum remains unverified.

## API

`POST /api/measurements/{dataset_id}/matching-audit`

Request fields include `anchorLatitude`, `anchorLongitude`, optional `sceneBounds`, active `transmitters`, optional RAT/profile/PCI/band/ARFCN filters, and `previewLimit`.

The response contains `identityProfiles`, `selectedProfile`, `candidateTransmitters`, a small measurement preview, and explicit caveats.

## Acceptance

Run [`testing/colab/RADIO_IDENTITY_MATCHING_COLAB_TEST.md`](testing/colab/RADIO_IDENTITY_MATCHING_COLAB_TEST.md) with synthetic, public, or anonymized data. The procedure does not publish profile counts, cell IDs, PCI values, transmitter labels, or field locations from a private dataset.

## Next step

After reviewing the candidate table against an independently maintained base-station/sector inventory, manually confirm a TX mapping for the selected profile. Then Measurement-Location Ray Tracing can sample the Sionna RT channel at a controlled subset of the same ENU coordinates.
