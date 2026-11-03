> **Privacy:** Use synthetic or anonymized data. Do not include private field routes, GPS coordinates, real radio/network identifiers, or unredacted screenshots in public reports.

# Repeatable Workflows — Colab Acceptance Test

## Test objective

Verify that application panels preserve their state across navigation and that completed actions can be run again without restarting the application. Do not use **Reset Project** between test cases.

## Setup

1. Export the current Project JSON as a backup.
2. Replace the project files with this release while preserving the project's `data/` directory.
3. Start the normal Colab setup/start workflow.
4. Confirm that the backend is online and the existing scene is loaded. If the Colab tunnel URL changed, open the new frontend URL.

## A. Field Validation and 3D measurement display

1. Open **Field Validation** and load the georeferenced an anonymized measurement CSV if it is not already available.
2. Run the radio identity matching audit and select the intended radio profile.
3. Display the grouped GPS locations in 3D.
4. Return to **Field Validation** and confirm that the audit, selected profile, record count, and display mode are preserved.
5. Display the locations again. Repeat at least three times, returning to Field Validation between runs.
6. Repeat for individual measurements and all imported records.

**Expected:** The action button becomes available again after each operation. There is no need to rerun identity matching, upload the dataset, or restart the application. The overlay can be shown and hidden repeatedly.

## B. Field-data operations

Without restarting the application, repeat at least twice: load a dataset, filter rows, run the geospatial audit, run the identity matching audit, export filtered CSV, and run a measurement-location ray-tracing sample. Change tabs between actions.

**Expected:** Busy indicators clear after success or failure, action buttons become enabled again, and saved results remain available unless a change to their source inputs intentionally invalidates them.

## C. Link and channel matrix

1. In **Link** mode, run **Channel Matrix**.
2. After it completes, run it again with the same settings.
3. Navigate to **Radio Coverage** and then return to **Link**.

**Expected:** The result and selected TX/RX pair remain available, and the Channel Matrix action can be run again after completion.

## D. Radio Coverage and Channel Analysis

1. Run a Radio Map calculation.
2. Navigate to **Trajectory** and return to **Radio Coverage**.
3. Run the map again, changing one solver parameter.
4. Open **Channel Analysis**, run an analysis, navigate to another tab, and return.

**Expected:** Panel settings and state are preserved. The previous map/analysis can be recalculated; the action button is not left disabled.

## E. NR PHY job and polling

1. Start an NR PHY BER/BLER job.
2. While polling is active, navigate to **Field Validation** or **Export**.
3. Return to **Analysis** and wait for completion.
4. Start the same job again after it completes.

**Expected:** Polling continues while another tab is active; the result appears when returning; a new job can be started after completion.

## F. Geography and Export

1. Change a setting in **Geography**, navigate to another tab, and return.
2. In **Export**, run an export, wait for it to finish, and repeat it.
3. Navigate between tabs during the test.

**Expected:** Panel-local settings are not reset by navigation, and export actions can be repeated.

## G. Mobility and trajectory playback

1. Run a Mobility calculation and save the result.
2. Navigate to **Link** or **Radio Coverage** while the result remains available.
3. Return to **Trajectory**.
4. Start playback, navigate to another mode, and return.

**Expected:** Mobility results and the trajectory remain available. Playback stops automatically when leaving the mode and can be started again.

## H. OSM download lifecycle

1. Start an OSM fetch.
2. Wait for completion and confirm that the button becomes active again.
3. Repeat the fetch with the same area.
4. If possible, test an empty response or a network error.

**Expected:** Fetch/Reset controls are disabled only while a request is in progress. The success/error message remains visible after completion but does not block another request.

## Evidence

For every test, record pass/fail, the number of repetitions, whether navigation occurred between runs, and a screenshot of the action button before and after execution. If a control remains disabled, record the tab, control label, last application message, and browser/network error.
