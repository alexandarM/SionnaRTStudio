# NR PHY Simulation — Configuration and Ray-Traced PUSCH Link-Level Guide

**Capabilities:** FR1 PUSCH configuration, normalized Eb/N0 sweeps, and an opt-in absolute channel/link-budget mode.\
**PHY implementation:** optional Sionna PHY 2.0.1 (`backend/requirements-phy.txt`).\
**Base application:** Radio Coverage Analytics + Channel Analysis + Spatial Association & Geolocation, including persistent radio-map view.

This document describes the NR PHY module, how its NR
configuration is mapped, what channel is being simulated, and what remains out
of scope. It is intentionally explicit so that plots are not mistaken for a
full 5G network simulation.

## 1. Module Scope

Implemented:

- FR1 nominal channel bandwidth / SCS to PRB mapping from 3GPP TS 38.104,
  Table 5.3.2-1, for the 15/30/60 kHz SCS values exposed here.
- Explicit PUSCH configuration: MCS table/index, PCI (`nCellId`), cyclic
  prefix, DMRS configuration type and additional DMRS position.
- Reciprocal single-link channel adapter from the native Sionna RT CIR to the
  Sionna PHY PUSCH uplink tensor layout.
- A unit-norm uniform precoder across the UE receive-array ports when forming
  the reciprocal one-stream uplink.
- BER and BLER with Wilson score 95% confidence intervals.
- Empirical decoded transport-block goodput per simulated slot duration.
- A conservative maximum excess delay / approximate minimum CP warning.
- Exact 0.5/1/2 dB sweep steps with endpoint validation and a 41-point cap.
- An opt-in absolute mode that preserves the unnormalized RT CFR and derives
  receiver noise from UE conducted power, occupied bandwidth, BS noise figure
  and a 293 K thermal-noise reference.
- Absolute-mode diagnostics for mean channel gain, combined receive power,
  receiver noise, effective SNR and approximate MCS-equivalent Eb/N0.
- Explicit labelling that Shannon capacity is an ideal upper bound and not
  achieved or scheduled NR throughput.

Not implemented by this module:

- PDSCH/downlink transmit and receive chain. The implemented NR physical
  channel is PUSCH, so this experiment is uplink via channel reciprocity.
- Multi-layer/multi-stream NR scheduling or rank adaptation.
- Inter-cell interference, PRB overlap, power control, scheduler or traffic
  load. The PUSCH sweep currently uses a single link plus AWGN.
- HARQ, MAC, RLC, PDCP, RRC, NAS, AKA or 5G core network.
- CQI feedback or adaptive MCS selection. MCS is an explicit user input.
- A full time-domain OFDM waveform channel with ISI/ICI when excess delay
  exceeds CP. The current replay channel applies a frequency-domain channel.

The application must not be described as a complete 5G system.

## 2. FR1 resource-grid mapping

The backend helper `backend/nr_config.py` contains a bounded copy of the FR1
maximum transmission bandwidth configuration values from 3GPP TS 38.104,
Table 5.3.2-1. Only combinations in this table are accepted when a nominal
channel bandwidth is supplied.

| SCS | Nominal channel bandwidths supported in this release |
|---:|---|
| 15 kHz | 5, 10, 15, 20, 25, 30, 35, 40, 45, 50 MHz |
| 30 kHz | 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100 MHz |
| 60 kHz | 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100 MHz |

Some example mappings:

| Nominal channel BW | SCS | PRB | Active subcarriers | Occupied subcarrier BW |
|---:|---:|---:|---:|---:|
| 20 MHz | 15 kHz | 106 | 1,272 | 19.08 MHz |
| 20 MHz | 30 kHz | 51 | 612 | 18.36 MHz |
| 20 MHz | 60 kHz | 24 | 288 | 17.28 MHz |
| 100 MHz | 30 kHz | 273 | 3,276 | 98.28 MHz |

The occupied bandwidth is `12 × PRB × SCS`. It is not the same as the
nominal channel bandwidth; the difference includes guard-band allowance.
Slot duration follows numerology: `1 ms / 2^mu`, with mu 0, 1 and 2 for
15, 30 and 60 kHz respectively.

For legacy API callers that omit `channelBandwidthMHz`, a manually supplied
`numPrb` remains supported. The browser UI uses the nominal channel bandwidth
selector and the standards table as the authority for the PRB count.

## 3. PUSCH configuration exposed by the UI

- **MCS table:** 1, 2 or 3 (3GPP TS 38.214 PUSCH MCS tables represented by the
  pinned Sionna PHY package). Table 2 is limited to index 27; tables 1 and 3
  allow index 28.
- **PCI:** `nCellId`, integer 0–1007. It is assigned to Sionna's carrier cell
  identity; `TBConfig.n_id` remains unset so Sionna follows its documented
  default relationship to the carrier cell ID.
- **Cyclic prefix:** normal at 15/30/60 kHz; extended only at 60 kHz.
- **DMRS:** configuration type 1 or 2 and additional position 0–3. One
  antenna port and one layer are configured in this release.
- **Sweep resolution:** selectable 0.5, 1.0 or 2.0 dB step, with exact
  endpoint validation. The backend caps sweep length to 41 points and each
  point to 512 slots.
- **Channel mode:** normalized Eb/N0 (default) or absolute link budget.
- **Absolute link-budget inputs:** UE conducted Tx power (default assumption
  23 dBm) and BS receiver noise figure (default assumption 7 dB).

The default UI example is 20 MHz / 30 kHz, MCS table 1 / index 14, PCI 1,
normal CP, DMRS type 1 / additional position 0, normalized Eb/N0 -10…14 dB,
1 dB step and 32 slots per point.

## 4. Native RT CIR to reciprocal PUSCH channel

Sionna RT native CIR coefficient axes returned by `solve_cir()`:

`a_dl: [num_rx, num_rx_ant(UE), num_tx, num_tx_ant(BS), num_paths, num_time_steps]`

For the current PHY job, one BS TX and one UE RX are required. Channel
reciprocity swaps the device and array roles:

`a_ul_ports: [batch=1, num_rx=1, num_rx_ant(BS), num_tx=1, num_tx_ant(UE), num_paths, num_time_steps]`

The single effective UE PUSCH stream uses a unit-norm uniform precoder over
the UE receive-array ports. The implementation sums the **UE transmit-port
axis** after adding the leading batch dimension, and preserves every path tap.
It does not sum the multipath dimension. The adapter is isolated in
`_prepare_reciprocal_ul_cir()` and covered by pure NumPy tests.

Compact RT delays have shape `[num_rx, num_tx, num_paths]`; antenna-expanded
delays are accepted only when delay values are equal across antenna pairs,
as expected for geometric propagation delays. The adapter rejects malformed
per-antenna delay values rather than silently selecting one.

The reciprocal channel is converted to CFR by Sionna PHY's
`cir_to_ofdm_channel()` on the PUSCH subcarrier grid. Normalized mode converts
the CFR with `normalize=True` and therefore scales it to unit average energy. This isolates channel frequency/spatial selectivity
from absolute path loss. In this mode Eb/N0 is relative to normalized received
symbol energy; it is not an absolute coverage-edge BLER prediction.

Absolute mode converts the same reciprocal CIR with `normalize=False`, keeping
the RT path-gain magnitude. It uses separate UE conducted transmit power
(default assumption 23 dBm), BS receiver noise figure (default assumption 7 dB),
293 K thermal noise and the active PUSCH occupied bandwidth. The 20 MHz /
30 kHz example uses 18.36 MHz occupied bandwidth, not the 20 MHz nominal
channel bandwidth. A 0 dB link offset is the physical link-budget operating
point; negative/positive offsets worsen/improve the noise level around it.
The displayed baseline Eb/N0 is approximate: it maps effective reference SNR
through the MCS modulation order and target code rate without a separate
resource-grid overhead correction.

Both modes use a single reciprocal uplink link and AWGN only; neither includes
inter-cell interferers.

Sionna's default `PUSCHReceiver` uses its default PUSCH LS channel estimator
with linear interpolation and the default linear detector with LMMSE
detection. No custom LMMSE channel interpolator is configured.

## 5. CP / excess-delay warning

The backend computes `maxExcessDelayNs` from the CIR delays (delay normalization
only shifts all paths by a common reference; it does not normalize their power)
and compares it with a conservative approximate minimum CP duration for the
selected SCS/CP. This is a warning indicator, not a symbol-by-symbol CP proof.
If excess delay exceeds the estimated CP, the frequency-domain channel model
may be optimistic because the current `ApplyOFDMChannel` replay does not
simulate the resulting inter-symbol/inter-carrier interference. A future
NR PHY Simulation time-domain extension should use a waveform-level channel implementation and
validate the exact symbol CP pattern for the selected numerology.

## 6. BER/BLER statistics and achieved goodput

For each Eb/N0 point, the API returns:

- BER = bit errors / decoded information bits.
- BLER = failed transport-block CRCs / received transport blocks.
- Wilson score 95% confidence intervals for both binomial rates.
- Empirical goodput = successfully CRC-decoded TB information bits divided
  by simulated slot duration.

Goodput is for this one simulated UE PUSCH link. It excludes scheduler
allocation, HARQ retransmissions, control/reference overhead outside the
configured PUSCH resource grid, MAC/RLC/PDCP headers, and core/network overhead.
It must not be presented as end-to-end user throughput.

The BER/BLER point reports exact counts (`bitErrors`, `bits`, `blockErrors`,
`blocks`) so the confidence interval can be interpreted. Zero observed errors
do not mean a true zero error probability; the interval upper bound remains
positive. Wilson intervals use a binomial model; bit errors within the same
coded transport block are correlated, so the BER interval is a descriptive
finite-sample indicator rather than a claim of independent bit-error trials.

## 7. API example

A typical request body can use the existing `/api/phyber` endpoint. The actual
`tx`, `rx`, `buildings`, `options` and `materials` must be copied from the
active application configuration; the short JSON below only illustrates the
NR fields:

```json
{
  "mcsIndex": 14,
  "mcsTable": 1,
  "channelBandwidthMHz": 20,
  "subcarrierSpacing": 30000,
  "nCellId": 1,
  "cyclicPrefix": "normal",
  "dmrsConfigType": 1,
  "dmrsAdditionalPosition": 0,
  "snrMinDb": -10,
  "snrMaxDb": 14,
  "snrStepDb": 1,
  "slotsPerPoint": 16,
  "seed": 42
}
```

The backend resolves `numPrb=51` from 20 MHz / 30 kHz. It returns the resolved
configuration as metadata with each completed result.

For absolute mode, add the following fields to the same request:

```json
{
  "channelMode": "absolute",
  "ueTxPowerDbm": 23,
  "receiverNoiseFigureDb": 7,
  "snrMinDb": -2,
  "snrMaxDb": 2,
  "snrStepDb": 1,
  "slotsPerPoint": 16
}
```

In absolute mode, `snrMinDb`/`snrMaxDb` are link-budget offsets rather than
independent absolute Eb/N0 values. The detailed equations and assumptions are
specified in `NR_ABSOLUTE_LINK_BUDGET_GUIDE.md`.

## 8. Colab acceptance test

The original NR PHY Simulation baseline acceptance procedure is retained below. For the
new fine-step and absolute-mode acceptance tests, use
[`ABSOLUTE_LINK_BUDGET_COLAB_TEST.md`](testing/colab/ABSOLUTE_LINK_BUDGET_COLAB_TEST.md).

1. Upload and start this full project archive using the existing notebook
   launcher. Confirm `/api/health` returns `ok: true` and `phy: true` after
   installing the optional package if needed.
2. Confirm the runtime Sionna PHY version is 2.0.1, matching
   `backend/requirements-phy.txt`. Also record torch, NumPy and active Mitsuba
   versions in the test log.
3. Load the existing scene and one BS–UE link. Keep the array sizes small for
   the first run (e.g. BS 1×1, UE 1×1) and select a scene/frequency already
   validated with Channel Analysis.
4. In Link Analysis, select 20 MHz, 30 kHz, MCS table 1/index 14, normal CP,
   DMRS type 1/position 0, Eb/N0 -4…8 dB, 16 slots per point.
5. Confirm the UI reports 51 PRBs and 612 active subcarriers before starting.
6. Run the sweep and retain the entire backend log/result JSON. Confirm the
   job reaches `done`, the result repeats the configuration, and every point
   contains BER/BLER counts, confidence intervals and goodput.
7. Confirm `blocks > 0`, `bits > 0`, both confidence intervals are ordered and
   bounded in [0,1], and goodput is finite/non-negative.
8. Repeat with a 2-port UE Rx array and 2-port BS Tx array if the RT scene
   supports it. Confirm the reciprocal PUSCH still has one effective UE
   stream, BS receive antenna count matches the BS array, and UE array port
   count is reported separately.
9. Repeat with another MCS table / DMRS configuration only after the baseline
   completes. A failed Sionna config should produce an explicit job error,
   not substituted settings.
10. Inspect the CP warning. If max excess delay exceeds approximate minimum
    CP, treat the current frequency-domain result as potentially optimistic.

Do not begin a large sweep (high PRB, high slot count and many Eb/N0 points)
until the small Colab run succeeds. CPU-side PHY is intentionally separate
from the GPU ray-tracing lock; it can still consume substantial RAM/CPU.

## 9. Source references

- 3GPP TS 38.104, Table 5.3.2-1 (FR1 maximum transmission bandwidth
  configuration): ETSI TS 138 104, Release 19, version 19.3.0, February 2026:
  <https://www.etsi.org/deliver/etsi_ts/138100_138199/138104/19.03.00_60/ts_138104v190300p.pdf>
- NVIDIA Sionna 2.0.1 RT-to-link-level Colab tutorial:
  <https://colab.research.google.com/github/NVlabs/sionna/blob/v2.0.1/tutorials/phy/Link_Level_Simulations_with_RT.ipynb>
- NVIDIA Sionna PUSCH tutorial and API, for PUSCH, MCS, DMRS and default
  receiver chain:
  <https://nvlabs.github.io/sionna/phy/tutorials/5G_NR_PUSCH.html>
  <https://nvlabs.github.io/sionna/phy/api/nr/sionna.phy.nr.PUSCHReceiver.html>

## 9. Fine sweep and absolute link-budget mode

For the exact sweep-step rules, physical link-budget equations, assumptions,
API diagnostics and Colab acceptance procedure, see
[`NR_ABSOLUTE_LINK_BUDGET_GUIDE.md`](NR_ABSOLUTE_LINK_BUDGET_GUIDE.md).
In particular, UE power and BS receiver NF are experimental inputs, not
measurements inferred from the BS transmitter configuration.
