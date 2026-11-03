> **Privacy:** Use synthetic or anonymized data. Do not include private field routes, GPS coordinates, real radio/network identifiers, or unredacted screenshots in public reports.

# SionnaRTStudio — Fine Eb/N0 Sweep & Absolute Link Budget Colab Acceptance Test

**Release:** fine-grained BER/BLER sweep + absolute ray-traced channel/link-budget PUSCH mode\
**Prerequisite:** the original NR PHY Simulation normalized PUSCH smoke test has already completed successfully in the user's Colab runtime.

This procedure validates the new UI/API path. Pure-Python unit tests do not replace the live Sionna RT + Sionna PHY run required here.

## A. Update the Colab project

1. Stop the existing backend process.
2. Upload/extract the complete ZIP from this release, preserving the notebook's usual project root and startup cells.
3. Confirm the optional PHY package is present. If `/api/health` reports `phy: false`, run from the project root:

   ```bash
   pip install -r backend/requirements-phy.txt
   ```

4. If dependencies were installed or replaced, restart the Colab runtime, rerun setup and launch the app.
5. Confirm `/api/health` returns `ok: true` and `phy: true`.
6. Confirm versions:

   ```python
   import sionna, torch, numpy as np
   print("Sionna:", sionna.__version__)
   print("Torch:", torch.__version__)
   print("NumPy:", np.__version__)
   ```

   The PHY requirement pins `sionna==2.0.1`. Record actual versions and runtime type in the test log.

## B. Test 1 — Fine-grained normalized sweep

Use the same BS–UE link/scene which already passed the earlier PUSCH test.

| UI control | Value |
|---|---:|
| Channel mode | Normalized Eb/N0 |
| MCS table / index | Table 1 / 14 |
| Channel BW / SCS | 20 MHz / 30 kHz |
| PCI | 1 (or the recorded test PCI) |
| CP | Normal |
| DMRS | Type 1 / additional position 0 |
| Eb/N0 from / to | -1 dB / +1 dB |
| Step | 0.5 dB |
| Slots/point | 64 |

Expected values displayed before the run:

- 51 PRB;
- 612 active subcarriers;
- 18.36 MHz occupied bandwidth.

Expected sweep x-values: `-1.0, -0.5, 0.0, +0.5, +1.0 dB`.

Acceptance checks:

- The job reaches `done` without a traceback.
- The result reports `channelMode=normalized` and `channelNormalized=true`.
- There are exactly five result points and no endpoint is omitted.
- Every point has non-zero `bits` and `blocks`, finite BER/BLER/goodput and valid Wilson intervals.
- Goodput is zero when all blocks fail CRC and positive if one or more blocks pass CRC.

Repeat with a 1 dB or 2 dB step only if needed to verify the other selector values. A range that is not divisible by its step (e.g. -1…+1 with 0.3 dB) must be rejected before the backend run.

## C. Test 2 — Absolute link-budget smoke test

Keep the same link, scene and NR settings. Change only the channel mode and absolute-mode inputs.

| UI control | Value |
|---|---:|
| Channel mode | Absolute link budget |
| UE Tx power | 23 dBm (initial assumption) |
| BS Rx noise figure | 7 dB (initial assumption) |
| Link offset from / to | -2 dB / +2 dB |
| Step | 1 dB |
| Slots/point | 16 initially |

Expected offsets: `-2, -1, 0, +1, +2 dB`.

The actual baseline Eb/N0 is scene/link dependent; do not predict a specific number before the solver returns the channel.

Acceptance checks:

1. The job reaches `done` without a backend traceback.
2. Result metadata reports `channelMode=absolute` and `channelNormalized=false`.
3. The result reports UE Tx power 23 dBm, BS NF 7 dB and noise temperature 293 K.
4. For 20 MHz / 30 kHz, `noiseBandwidthHz` is 18.36 MHz, based on 612 active subcarriers rather than nominal 20 MHz.
5. `meanChannelGainDb`, `rxPowerDbm`, `noisePowerDbm`, `effectiveSnrDb` and `linkBudgetEbNoDb` are finite.
6. There are exactly five points with offsets -2, -1, 0, +1 and +2 dB.
7. Each result point's displayed `ebNoDb` equals the approximate baseline `linkBudgetEbNoDb` plus its link offset (subject only to display rounding).
8. BER/BLER confidence intervals are ordered and bounded by [0,1]; goodput is finite and non-negative.
9. A zero-gain/no-path channel must produce a clear job error; it must not silently return an invented finite link budget.

### Sensitivity check (after the smoke test)

Run two small additional absolute sweeps at the same scene/link and same NF:

- increase UE Tx power by 3 dB (e.g. 23 → 26 dBm): calculated link-budget baseline should increase by approximately 3 dB;
- restore UE power and increase BS NF by 3 dB (e.g. 7 → 10 dB): calculated baseline should decrease by approximately 3 dB.

Do not change the scene, array, bandwidth, MCS or solver configuration during these comparisons.

## D. Increase Monte Carlo work only after A–C pass

1. Increase slots/point from 16 to 128 for the same five-point absolute sweep.
2. If runtime/memory allow, use 256 or 512 slots per point for a tighter BLER estimate.
3. Retain exact error counts and confidence intervals. Zero observed errors are not proof of zero underlying error probability.
4. Do not change MCS and power at the same time when interpreting a result.

## E. Interpret the absolute mode correctly

- `ueTxPowerDbm` is a separate UE conducted-power input. It is not copied from the BS `tx.powerDbm` field.
- 23 dBm is only an initial assumption. Replace it with a documented device/band-specific UE conducted-power value when known.
- 7 dB is only an initial BS receiver noise-figure assumption. Replace it with measured or manufacturer data when available.
- Receiver noise uses 293 K and the active occupied PUSCH bandwidth (`12 × PRB × SCS`).
- `rxPowerDbm` is average combined receive-signal power summed over BS receive branches; `noisePowerDbm` is the integrated noise over occupied bandwidth per BS branch.
- `linkBudgetEbNoDb` is an approximate MCS-equivalent baseline from effective SNR and `Qm × target code rate`; it does not apply a separate exact resource-grid overhead correction.
- A link offset of 0 dB is the modeled thermal-noise operating point. Negative offsets increase noise; positive offsets reduce noise.
- Absolute mode retains RT path gain but does not add uplink power control, inter-cell interference, scheduler, HARQ, RF implementation losses or a full time-domain waveform channel.
- The receiver remains a single-stream PUSCH receiver over a reciprocal RT channel; this is not a complete 5G network simulation.

## F. What to send back if it fails

Retain and provide:

1. `/api/health` JSON;
2. Sionna, Torch and NumPy version output;
3. screenshot of the complete PHY controls and error/result panel;
4. full backend traceback;
5. chosen UE Tx power, BS NF, channel mode, sweep bounds, step, slots/point, array sizes and scene frequency;
6. whether the RT solve completed and the returned CIR shape / path count if available.

Do not increase slots or change multiple physical parameters while diagnosing a failed run.
