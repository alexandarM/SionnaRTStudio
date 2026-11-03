# Repeatable Workflows & UI State Lifecycle

## Summary

This release addresses a cross-application issue in which panels or action controls could appear disabled after an operation and subsequent navigation. The root cause was panel unmounting: switching tabs removed React components from the component tree, discarding their local state and ownership of active polling. Returning to the tab created a fresh panel instance with default state.

## Changes

1. **Persistent workspace panels.** Link, Radio Coverage, and Trajectory panels remain mounted while another workspace mode is active. Geography, Analysis, Field Validation, and Export also retain their state across primary-tab navigation. Inactive panels are hidden without being destroyed.
2. **Preserved workflow state.** Selected radio profiles, identity-matching results, analysis results, settings, and local UI state remain available after navigation. The Analysis panel retains ownership of its PHY job polling while the user visits another tab.
3. **Controlled playback lifecycle.** The Trajectory panel remains mounted, but playback pauses when the user leaves the Trajectory mode. Mobility results and the selected route remain available.
4. **Reliable OSM request lifecycle.** The `gisLoading` flag is reset in a `finally` block for success, failure, and early returns caused by empty results. Arbitrary `setTimeout`-based unlocking was removed. The completion message remains visible without leaving the action button disabled.
5. **Nested dataset refresh.** After a CSV import, refreshing the dataset list no longer takes ownership of or prematurely clears the upload action's busy state.
6. **Lifecycle regression check.** `npm run check:panel-lifecycle` verifies workspace/mode retention, the PHY polling owner, Field Validation state, playback pause, OSM control unlocking, and feedback visibility.

## Intentional behavior

The 3D WebGL renderer (`ThreeStudio`) is mounted only while the 3D Scene tab is active, to manage WebGL/GPU memory. Scene data, buildings, TX/RX devices, radio-map data, and overlay state are retained by the parent application state. Returning to 3D Scene should not require downloading the OSM map again.

A control may remain disabled while its own request is in flight. A deliberate **Reset Project**, replacement of source data, or a configuration change that invalidates a result may clear dependent state. Those behaviors are separate from ordinary tab navigation.

## Validation scope

The repository includes targeted panel-lifecycle checks and backend regression tests. A complete Vite production build and final interactive validation in a clean Google Colab runtime must be confirmed in the target environment before release.
