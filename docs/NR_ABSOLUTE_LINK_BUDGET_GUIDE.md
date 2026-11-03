# Fine Eb/N0 Sweep & Absolute Link Budget — NR PHY Guide

**Related module:** NR PHY Simulation (FR1 PUSCH over a reciprocal Sionna RT channel).\
**Purpose:** refine BER/BLER curves and add an explicitly parameterized physical link-budget operating point without changing the existing normalized experiment.

## 1. What changed

This update adds two independent improvements to the existing PUSCH experiment:

1. A selectable Eb/N0 / link-offset step of **0.5, 1.0 or 2.0 dB**.
2. A **Channel mode** selector with `Normalized Eb/N0` and `Absolute link budget`.

The default remains `Normalized Eb/N0`, preserving the previous experiment. The new absolute mode is opt-in and requires the user to enter a UE conducted transmit-power assumption and a BS receiver noise figure.

The backend creates an exact decimal-safe sweep. The requested stop value must land exactly on the selected step and the backend limits a sweep to 41 points. For example:

| Start | Stop | Step | Generated points |
|---:|---:|---:|---|
| -1 dB | +1 dB | 0.5 dB | -1, -0.5, 0, 0.5, 1 dB |
| -2 dB | +2 dB | 1 dB | -2, -1, 0, 1, 2 dB |
| -2 dB | +4 dB | 2 dB | -2, 0, 2, 4 dB |

A non-divisible range is rejected instead of silently omitting the last point.

## 2. Normalized mode (the original experiment)

In normalized mode, the reciprocal RT CIR is converted to CFR with Sionna PHY's `cir_to_ofdm_channel(..., normalize=True)`.

This scales the CFR to unit average energy. The sweep values are direct Eb/N0 values supplied by the user, and the noise variance is derived with Sionna's `ebnodb2no()` using the selected modulation order and target code rate.

This mode is useful to isolate the impact of the RT channel's frequency/spatial selectivity from its absolute path loss. It is **not** an absolute coverage-edge BER/BLER prediction.

The previous behavior is preserved, except that the step can now be selected as 0.5, 1 or 2 dB.

## 3. Absolute link-budget mode

Absolute mode converts the same reciprocal RT CIR to CFR with `normalize=False`. This keeps the path-gain magnitude represented by the native RT coefficients. The mode then derives one physical reference operating point from:

- mean unnormalized RT channel gain over the PUSCH time/frequency grid;
- explicit UE conducted transmit power;
- active PUSCH occupied bandwidth;
- BS receiver noise figure;
- thermal noise temperature of 293 K.

### 3.1 Why UE power is a separate parameter

The current RT scene is solved in the BS → UE direction and its `tx.powerDbm` belongs to the base-station transmitter model. PUSCH is an uplink channel (UE → BS). Therefore this workflow deliberately does **not** reuse the base-station `tx.powerDbm` field as uplink power.

The UI exposes a separate `UE Tx power (dBm)` field. Its default of **23 dBm is an assumption for the experiment**, not a measured value from the user's modem and not a universal UE power limit. Replace it with a documented device/band-specific conducted-power value when known.

`BS Rx noise figure (dB)` is also an explicit assumption; the default is 7 dB. The user should replace it if a measured or manufacturer-specified receiver NF is available.

### 3.2 Occupied bandwidth and thermal noise

The noise bandwidth is the active PUSCH subcarrier bandwidth, not the nominal channel bandwidth:

\[
B_{occ}=12\,N_{PRB}\,\Delta f
\]

For 20 MHz nominal bandwidth and 30 kHz SCS, the FR1 table gives 51 PRBs and 612 active subcarriers:

\[
B_{occ}=612\times30\,\mathrm{kHz}=18.36\,\mathrm{MHz}
\]

The integrated thermal noise plus receiver noise figure is:

\[
P_n=kTB_{occ}\,10^{NF/10}
\]

where \(k=1.380649\times10^{-23}\,\mathrm{J/K}\), \(T=293\,\mathrm{K}\), and \(NF\) is the receiver noise figure in dB.

The returned `noisePowerDbm` is the integrated noise power over this occupied
bandwidth **per BS receive branch**. Since the frequency-domain resource
symbols are unit-average-energy and total UE conducted power is split evenly
across `Nsc` active subcarriers, the per-subcarrier signal/noise ratio is
\( (P_{UE}/N_{sc}) / (kT\,10^{NF/10}\,\Delta f) \). Rearranging gives the
scalar ratio \(kT\,10^{NF/10}\,(N_{sc}\Delta f)/P_{UE}=P_n/P_{UE}\) used below.

### 3.3 Mean channel gain and received power

After the UE array ports have been combined by the existing unit-norm uniform one-stream precoder, the backend calculates the mean CFR power, summing the BS receive-branch powers:

\[
\bar G=\mathbb{E}_{t,f}\left[\sum_{m\in BS\ RX}|H_m(t,f)|^2\right]
\]

The corresponding mean combined receive signal power is:

\[
P_{rx,combined,dBm}=P_{UE,dBm}+10\log_{10}(\bar G)
\]

The UI labels this quantity **Mean combined Rx signal power**. It is a channel-model estimate under the entered UE power assumption, not a modem measurement.

The backend calculates a mean link-budget reference SNR by subtracting the
per-branch receiver noise level from the summed receive-signal power. This is
a reference based on mean CFR power and the single-stream receive-combining
assumption; it is not the per-resource-element SINR reported by the LMMSE
equalizer or a measured receiver output.

### 3.4 PUSCH noise variance

The UE conducted power is assumed to be uniformly distributed over the active PUSCH bandwidth, with unit-average-energy active resource elements. Under that convention the complex-baseband noise variance passed to `ApplyOFDMChannel` is:

\[
\sigma_n^2=\frac{P_n}{P_{UE}}
\]

This ratio gives the per-resource-element signal-to-noise ratio when total UE
power is spread uniformly over the active subcarriers. It is not a new transmit-power scaling applied to the RT channel; the absolute path gain remains in the unnormalized CFR.

### 3.5 Approximate MCS-equivalent Eb/N0 baseline

For the selected modulation order \(Q_m\) (bits per QAM symbol) and target code rate \(R\), the UI reports an approximate equivalent Eb/N0 reference:

\[
(E_b/N_0)_{baseline}\approx SNR_{effective}-10\log_{10}(Q_mR)
\]

This is an MCS-equivalent display/reference conversion that follows the same basic modulation-order/code-rate relationship used by the normalized sweep. It does **not** separately apply every resource-grid overhead correction (DMRS, CP and other RE accounting) in this displayed scalar. Therefore the field is explicitly labelled **Approx. link-budget Eb/N0** and should be treated as an approximate reference for the experiment, not a calibrated UE sensitivity or standards conformance result.

### 3.6 Meaning of the absolute-mode sweep bounds

In absolute mode, the user-entered range is **not** an independent Eb/N0 input. It is a link-budget offset around the derived physical operating point:

- **0 dB offset:** the modeled thermal-noise link-budget operating point;
- **-1 dB offset:** 1 dB worse than that point (noise variance is increased by 1 dB);
- **+1 dB offset:** 1 dB better than that point (noise variance is reduced by 1 dB).

The sweep applies:

\[
\sigma_n^2(\delta)=\sigma_{n,baseline}^2\,10^{-\delta/10}
\]

The response point's `ebNoDb` is the approximate baseline Eb/N0 plus the selected offset. `linkBudgetOffsetDb` is also returned explicitly, and the table displays both values.

## 4. UI controls and defaults

| Control | Meaning | Default |
|---|---|---:|
| Channel mode | Normalized Eb/N0 or Absolute link budget | Normalized |
| UE Tx power | Assumed UE conducted uplink power | 23 dBm |
| BS Rx noise figure | Receiver NF used for thermal-noise calculation | 7 dB |
| Step | Sweep interval | 1 dB |
| Slots/point | Number of PUSCH slots per sweep point | 32 |

The UI offers 0.5, 1.0 and 2.0 dB sweep steps, and 16, 32, 64, 128, 256 or 512 slots per point. It disables invalid ranges that do not land on the selected step or that exceed the 41-point backend limit.

When the user switches to absolute mode, the UI proposes a -2…+2 dB link-offset sweep at 1 dB steps. This is only an initial test range; the physical Eb/N0 axis is shifted by the link budget calculated for the selected scene/link.

## 5. What this mode does not yet model

Absolute link budget is a more physically anchored experiment than the normalized mode, but it is not a complete calibrated radio system. It currently does not model:

- NR uplink power control (open-loop/closed-loop TPC);
- inter-cell or intra-cell co-channel interference;
- scheduler, PRB allocation across multiple UEs or load;
- HARQ retransmissions;
- RF-chain losses, PA back-off, implementation loss or UE power spectral-density shaping;
- measured UE antenna mismatch/pattern unless such a pattern is actually represented in the RT array model;
- receiver implementation loss beyond the configured noise figure;
- a complete time-domain waveform channel with ISI/ICI when excess delay exceeds CP.

The existing reciprocal-channel assumption remains: the RT path is traced BS → UE and adapted to a single-stream UE → BS PUSCH channel. This is a propagation-channel reciprocity model; it is not a complete FDD model and does not account for differences between real transmit/receive RF chains.

If the RT link has no non-zero path gain, absolute mode returns a clear error instead of inventing a zero or finite link-budget value.

## 6. Recommended Colab tests

### Test A — Fine normalized sweep

Use the same already accepted link and PHY configuration:

| Control | Value |
|---|---:|
| Channel mode | Normalized Eb/N0 |
| MCS | Table 1 / index 14 |
| Channel bandwidth / SCS | 20 MHz / 30 kHz |
| PCI / CP | 1 / Normal |
| DMRS | Type 1 / position 0 |
| Eb/N0 from / to | -1 dB / +1 dB |
| Step | 0.5 dB |
| Slots/point | 64 initially |

Expected sweep points: -1, -0.5, 0, +0.5, +1 dB. Confirm five rows appear, all counts are positive, and the result metadata says `channelMode=normalized` and `channelNormalized=true`.

### Test B — Absolute link-budget smoke test

Keep the same link and configuration, but use:

| Control | Value |
|---|---:|
| Channel mode | Absolute link budget |
| UE Tx power | 23 dBm (initial assumption) |
| BS Rx noise figure | 7 dB (initial assumption) |
| Link offset from / to | -2 dB / +2 dB |
| Step | 1 dB |
| Slots/point | 16 initially |

Expected offset points: -2, -1, 0, +1, +2 dB. The physical effective Eb/N0 is scene-dependent and must not be guessed in advance.

Acceptance checks:

1. Job reaches `done` with no backend traceback.
2. Metadata reports `channelMode=absolute` and `channelNormalized=false`.
3. `ueTxPowerDbm=23`, `receiverNoiseFigureDb=7`, and `noiseTemperatureK=293` appear in the result.
4. For 20 MHz / 30 kHz, `noiseBandwidthHz` is 18.36 MHz.
5. `meanChannelGainDb`, `rxPowerDbm`, `noisePowerDbm`, `effectiveSnrDb` and `linkBudgetEbNoDb` are finite.
6. There are five result points and their `linkBudgetOffsetDb` values are exactly -2, -1, 0, +1, +2 dB.
7. The displayed effective Eb/N0 equals the returned approximate baseline plus the corresponding offset.
8. BER/BLER confidence intervals remain ordered and in [0,1]; goodput is finite and non-negative.
9. Changing UE power by +3 dB in a separate small run should move the calculated link-budget baseline by approximately +3 dB, all else equal. Changing receiver NF by +3 dB should move it by approximately -3 dB.

Only after the smoke test succeeds, increase to 128 slots per point. For a stronger statistical BLER estimate, use more blocks (e.g. 512 or higher if runtime permits) and report the actual counts/intervals.

## 7. Interpreting and reporting results

Always state:

- normalized or absolute channel mode;
- UE conducted power assumption and BS noise figure in absolute mode;
- occupied bandwidth (not only nominal channel bandwidth);
- SCS, PRB, MCS table/index, modulation and target code rate;
- sweep step and slots/blocks per point;
- BER/BLER counts and confidence intervals;
- whether the link had a CP/excess-delay warning.

Do not compare normalized-mode Eb/N0 directly with absolute-mode link-budget Eb/N0 as though they were generated under the same power model. Do not call the result modem-measured RSRP, SS-RSRP, or a full network throughput prediction.
