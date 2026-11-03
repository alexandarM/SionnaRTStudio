> **Privacy:** Use synthetic or anonymized data. Do not include private field routes, GPS coordinates, real radio/network identifiers, or unredacted screenshots in public reports.

# SionnaRTStudio — NR PHY Simulation Colab Acceptance Test

**Module:** NR PHY Simulation (FR1 configuration + reciprocal PUSCH)
**Purpose:** confirm the first actual Sionna PHY execution in the user's Colab runtime.

Do not start with a large bandwidth, large array, many Eb/N0 points and hundreds
of slots. Establish one small, reproducible baseline first.

## A. Prepare runtime

1. Stop the running SionnaRTStudio backend.
2. Upload/extract the full NR PHY Simulation ZIP using the same notebook launcher used for
   Spatial Association & Geolocation.
3. In the project root, install the optional PHY package if not already present:

   ```bash
   pip install -r backend/requirements-phy.txt
   ```

4. Restart the Colab runtime if package installation replaced a package already
   imported by the notebook.
5. Start the application with the existing `setup.sh` / `run.sh` workflow.
6. Open `/api/health` and retain the response. Require `ok: true` and `phy: true`.
7. Confirm the exact PHY package version:

   ```python
   import sionna
   import torch
   import numpy as np
   print("Sionna:", sionna.__version__)
   print("Torch:", torch.__version__)
   print("NumPy:", np.__version__)
   ```

   The optional requirements file pins `sionna==2.0.1`; record if the resolved
   runtime differs before interpreting a result.

## B. Baseline scenario

Use a link already validated by Channel Analysis. Choose a reachable UE position, and
start with small arrays (BS 1×1, UE 1×1) so shape and configuration failures are
easier to isolate.

In **Link Analysis → PHY BER / BLER**, select:

| Control | Baseline value |
|---|---:|
| MCS table | 1 |
| MCS index | 14 |
| Nominal channel bandwidth | 20 MHz |
| SCS | 30 kHz |
| PCI | Actual deployed cell identity if known; otherwise document the test value |
| Cyclic prefix | Normal |
| DMRS | Type 1, additional position 0 |
| Eb/N0 | -4 to +8 dB, 2 dB step |
| Slots per point | 16 |

Before starting, confirm that the UI displays:

- 51 PRBs;
- 612 active subcarriers;
- 18.36 MHz occupied subcarrier bandwidth inside the 20 MHz nominal channel.

Run the sweep once and capture the result, progress completion and backend log.

## C. Baseline acceptance criteria

The job must reach **Done** without a backend traceback. The result must report:

- MCS table/index, modulation order and target code rate;
- 20 MHz / 30 kHz / 51 PRB / 612 subcarriers;
- PCI, CP and DMRS configuration;
- one effective PUSCH UE stream and the physical BS/UE array port counts;
- positive path count;
- number of simulated slots and transport-block size;
- BER and BLER values and exact error/sample counts per Eb/N0 point;
- Wilson 95% lower/upper bounds for BER and BLER;
- finite, non-negative empirical decoded-TB goodput;
- max excess delay and approximate minimum CP duration.

For every BER/BLER confidence interval:

- lower bound must be ≥ 0;
- upper bound must be ≤ 1;
- lower bound must not exceed upper bound;
- a zero observed error count must still have a positive upper confidence bound.

Goodput must be zero when every transport block fails CRC and positive only
when at least one TB is decoded successfully.

## D. Additional tests (only after B succeeds)

1. **15 kHz case:** select 20 MHz / 15 kHz. Expected grid: 106 PRBs,
   1,272 subcarriers, 19.08 MHz occupied bandwidth.
2. **60 kHz case:** select 20 MHz / 60 kHz. Expected grid: 24 PRBs,
   288 subcarriers, 17.28 MHz occupied bandwidth.
3. **Extended CP:** at 60 kHz only, run a separate small sweep with extended
   CP. The UI must not allow extended CP at 15 or 30 kHz.
4. **MCS table 2:** try a conservative MCS index such as 10 first, then a
   higher one only if the baseline runs. Table 2 index 28 must be rejected by
   request validation; its valid range ends at 27 in this release.
5. **DMRS type 2:** run a small sweep with type 2 and position 1; confirm that
   the run either completes with metadata reflecting that exact setup or
   returns a clear Sionna configuration error. Settings must not silently fall
   back to type 1.
6. **Array reciprocity:** use a 2-port UE array and 2-port BS array if the scene
   supports them. The result should report the physical UE array port count and
   BS receive port count, while the PUSCH stream count remains one.
7. **CP warning:** inspect whether max excess delay exceeds the approximate
   minimum CP. If it does, record the run as potentially optimistic: current
   frequency-domain channel replay does not simulate resulting ISI/ICI.

## E. Interpret results correctly

- The implemented channel is reciprocal uplink PUSCH (UE → BS), not PDSCH.
- The RT-derived channel is normalized to unit average energy before Eb/N0
  sweeping. This result excludes absolute path loss and is not absolute
  coverage-edge BLER.
- The sweep uses a single link plus AWGN. It does not include other sectors or
  inter-cell interference.
- Empirical goodput is decoded transport-block information bits per simulated
  slot duration. It is not application throughput and excludes scheduler,
  HARQ, control, MAC/RLC/PDCP and core-network overhead.
- Shannon capacity in the separate Link-Level KPI panel is an idealized upper
  bound and must not be compared as though it were the achieved PUSCH goodput.

## F. What to send back if it fails

Retain and provide:

1. `/api/health` JSON;
2. output of the version cell in section A;
3. full backend traceback from the terminal/log;
4. selected NR configuration and the selected TX/RX antenna array sizes;
5. whether `solve_cir` completed and the returned CIR shape if it did.

Do not increase the slot count or change multiple configuration dimensions at
once when diagnosing a failure.
