# 3D Measurement Display Modes — Release Notes

## Added

- Three field-measurement overlay modes: unique GPS locations, individual measurements from the selected radio identity, and all imported records.
- RAT, PCI, and valid-RSRP filters for the all-records view.
- Neutral markers for records with invalid/missing RSRP when all validity states are included.
- Source-row inspector with timestamp, RAT/PCI, RSRP, RSRQ, SINR, and QC flags.
- Full underlying reading list in grouped-location mode and for coincident individual markers.
- HUD count distinguishes displayed markers from source measurement rows.

## Preserved

- WGS84-to-ENU reprojection when the active scene anchor changes.
- Overlay persistence between Field Validation and 3D Scene.
- Hide/show and center/reframe controls.
- Fixed display-only marker height; no unverified GPS altitude is used.
- No changes to scene geometry or Sionna RF solver inputs.

## Validation note

Marker and source-row counts are calculated from the currently selected dataset and radio identity at runtime. No private field-data counts or route coordinates are included in this release note. See the dataset-agnostic procedure in [`../testing/colab/3D_MEASUREMENT_DISPLAY_MODES_COLAB_TEST.md`](../testing/colab/3D_MEASUREMENT_DISPLAY_MODES_COLAB_TEST.md).
