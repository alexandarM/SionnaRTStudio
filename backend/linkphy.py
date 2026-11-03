"""Full PHY link-level chain: ray-traced CIR → 5G NR PUSCH BER/BLER sweep.

Tier 2 of the link-level feature. The ray-traced channel of the active link is
replayed through Sionna PHY's standard-compliant NR PUSCH chain — transport
block segmentation + LDPC, QAM, DMRS-based LS channel estimation, LMMSE
equalization — and swept over Eb/N0 to produce BER/BLER waterfall curves.

The RT link is base-station array → configurable UE receive array. Sionna's NR
module implements PUSCH (uplink), so the chain runs the RECIPROCAL link: one UE
stream is uniformly precoded over the UE array and the base-station array
receives over the transposed per-element channel (reciprocity holds per antenna
pair). The default normalized mode scales CFR to unit average energy so the
Eb/N0 curve isolates frequency/spatial selectivity from absolute path loss.
The optional absolute mode preserves raw RT channel gain and derives thermal
noise from explicit UE transmit power, occupied PUSCH bandwidth and BS receiver
noise figure.

The ``sionna`` PHY package (torch-based) is OPTIONAL: ``phy_available()`` is a
cheap probe used by /api/health, and the heavy imports happen only inside a
running job. The PHY is pinned to the CPU so the GPU stays exclusive to
Mitsuba/DrJit ray tracing (backend/requirements-phy.txt to install).
"""
# Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
# Upstream: https://github.com/puloktarafder/SionnaRTStudio

from __future__ import annotations

import importlib.util
import math
from typing import Callable


NOISE_TEMPERATURE_K = 293.0
BOLTZMANN = 1.380649e-23


def phy_available() -> bool:
    """True when the optional Sionna PHY package is importable (no import cost)."""
    try:
        return importlib.util.find_spec("sionna.phy") is not None
    except Exception:
        return False


def _prepare_reciprocal_ul_cir(a, tau):
    """Prepare one DL CIR as a reciprocal single-stream PUSCH uplink CIR.

    Input ``a`` follows Sionna RT's native layout:
    [num_rx, num_rx_ant(UE), num_tx, num_tx_ant(BS), num_paths, num_time].
    Output ``a_ul`` follows Sionna PHY's batched layout:
    [1, num_rx=1, num_rx_ant(BS), num_tx=1, num_tx_ant=1, paths, time].

    The UE antenna ports are combined with a unit-norm uniform precoder. After
    adding the batch axis, UE Tx antenna ports are axis 4; the path axis is 5
    and is deliberately preserved.
    ``tau`` is geometry-only and can be compact [rx,tx,path] or expanded over
    antenna axes.
    """
    import numpy as np

    a = np.asarray(a)
    tau = np.asarray(tau, dtype=float)
    if a.ndim != 6:
        raise ValueError(f"Expected 6-D CIR coefficients, got shape {a.shape}")
    if a.shape[0] != 1 or a.shape[2] != 1:
        raise ValueError("PUSCH adapter currently supports one single Tx-Rx link")
    num_paths = int(a.shape[-2])
    if num_paths < 1:
        raise ValueError("No ray-traced paths are available for the PUSCH channel")

    # Swap device and array roles: the original UE Rx ports become one
    # uniformly precoded UE uplink stream; original BS Tx ports become BS Rx.
    # Shape before UE-port combining: [batch=1, rx=1, BS_ports, tx=1,
    # UE_ports, paths, time].
    a_ul_ports = np.transpose(a, (2, 3, 0, 1, 4, 5))[None, ...]
    num_ue_array_ports = int(a.shape[1])
    if num_ue_array_ports < 1:
        raise ValueError("The UE receive array has no physical antenna ports")
    # Axis 4 is the UE antenna-port axis after the leading batch dimension.
    # Axis 5 is the ray-path axis and must remain intact for frequency-selective
    # multipath reconstruction.
    a_ul = a_ul_ports.sum(axis=4, keepdims=True) / math.sqrt(num_ue_array_ports)

    compact_shape = (a.shape[0], a.shape[2], num_paths)
    expanded_shape = a.shape[:-1]
    if tau.shape == compact_shape:
        tau_compact = tau
    elif tau.shape == expanded_shape:
        # RT delays are geometric and should be shared by all antenna pairs.
        # Reject a malformed per-antenna delay tensor rather than silently
        # choosing one port and producing a physically inconsistent channel.
        tau_ports = np.transpose(tau, (2, 3, 0, 1, 4))
        tau_compact = tau_ports[:, 0, :, 0, :]
        reference = tau_compact[:, None, :, None, :]
        if not np.allclose(tau_ports, reference, rtol=1e-6, atol=1e-12):
            raise ValueError("CIR delays must be antenna-independent for reciprocal PUSCH")
    else:
        raise ValueError(
            f"Unexpected CIR delay shape {tau.shape}; expected {compact_shape} "
            f"or {expanded_shape}"
        )

    # Swap the compact device axes. With one Tx and one Rx, this becomes
    # [batch=1, rx=1, tx=1, paths].
    tau_ul = np.transpose(tau_compact, (1, 0, 2))[None, ...]
    return a_ul, tau_ul, num_ue_array_ports


def _slot_batch_sizes(total_slots: int, batch_size: int = 16) -> list[int]:
    """Split a PUSCH sweep point into bounded batches for progress and memory safety."""
    total = int(total_slots)
    size = int(batch_size)
    if total < 1:
        raise ValueError("slots_per_point must be at least one")
    if size < 1:
        raise ValueError("batch_size must be at least one")
    batches: list[int] = []
    remaining = total
    while remaining:
        current = min(size, remaining)
        batches.append(current)
        remaining -= current
    return batches


def _wilson_interval(successes: int, trials: int, z: float = 1.959963984540054) -> tuple[float, float]:
    """Two-sided 95% Wilson score interval for a binomial error rate."""
    if trials <= 0 or successes < 0 or successes > trials:
        raise ValueError("Wilson interval requires 0 <= successes <= trials and trials > 0")
    n = float(trials)
    p = successes / n
    z2 = z * z
    denominator = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / denominator
    half = z * math.sqrt((p * (1.0 - p) / n) + (z2 / (4.0 * n * n))) / denominator
    lower = 0.0 if successes == 0 else max(0.0, center - half)
    upper = 1.0 if successes == trials else min(1.0, center + half)
    return lower, upper


def _absolute_link_budget(
    *,
    mean_channel_gain: float,
    ue_tx_power_dbm: float,
    occupied_bandwidth_hz: float,
    receiver_noise_figure_db: float,
    bits_per_symbol: int,
    coderate: float,
    temperature_k: float = NOISE_TEMPERATURE_K,
) -> dict:
    """Derive the reciprocal PUSCH operating point from physical RT gain.

    ``mean_channel_gain`` is the average of sum(|H|^2) over occupied
    subcarriers/time after unit-norm UE-array precoding, summing BS receive
    branch gains. The UE total conducted power is assumed uniformly spread
    over the occupied PUSCH bandwidth. ``noise_variance`` is the thermal+NF
    noise over that occupied bandwidth divided by UE Tx power; it is the
    variance to pass to ApplyOFDMChannel when each active RE has unit average
    symbol energy.

    The reported receive power is the mean sum power across BS receive
    branches, while noisePowerDbm is per BS receive branch. Their difference
    is the post-combining SNR under the receiver's spatial combining model.
    """
    values = (
        float(mean_channel_gain), float(ue_tx_power_dbm),
        float(occupied_bandwidth_hz), float(receiver_noise_figure_db),
        float(coderate), float(temperature_k),
    )
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Absolute link-budget inputs must be finite")
    gain, tx_dbm, bandwidth, noise_figure, rate, temperature = values
    if gain <= 0.0:
        raise ValueError("Absolute channel mode requires a non-zero ray-traced channel gain")
    if bandwidth <= 0.0 or temperature <= 0.0:
        raise ValueError("Noise bandwidth and temperature must be positive")
    if int(bits_per_symbol) < 1 or not 0.0 < rate <= 1.0:
        raise ValueError("Invalid modulation order or target code rate")

    # This follows the same 293 K thermal-noise convention as linklevel.py.
    noise_power_w = BOLTZMANN * temperature * bandwidth * 10.0 ** (noise_figure / 10.0)
    tx_power_w = 10.0 ** ((tx_dbm - 30.0) / 10.0)
    if not math.isfinite(noise_power_w) or not math.isfinite(tx_power_w) or tx_power_w <= 0.0:
        raise ValueError("Could not derive finite positive Tx/noise power")

    noise_power_dbm = 10.0 * math.log10(noise_power_w * 1e3)
    combined_rx_power_dbm = tx_dbm + 10.0 * math.log10(gain)
    effective_snr_db = combined_rx_power_dbm - noise_power_dbm
    ebno_factor = int(bits_per_symbol) * rate
    link_budget_ebno_db = effective_snr_db - 10.0 * math.log10(ebno_factor)
    noise_variance = noise_power_w / tx_power_w
    if not math.isfinite(noise_variance) or noise_variance <= 0.0:
        raise ValueError("Derived absolute-mode noise variance is not finite and positive")

    return {
        "noisePowerDbm": noise_power_dbm,
        "noisePowerW": noise_power_w,
        "txPowerW": tx_power_w,
        "noiseVariance": noise_variance,
        "combinedRxPowerDbm": combined_rx_power_dbm,
        "effectiveSnrDb": effective_snr_db,
        "linkBudgetEbNoDb": link_budget_ebno_db,
        "meanChannelGainDb": 10.0 * math.log10(gain),
        "noiseBandwidthHz": bandwidth,
        "noiseTemperatureK": temperature,
    }


def run_pusch_ber_sweep(
    cir: dict,
    *,
    mcs_index: int,
    num_prb: int,
    snr_points_db: list[float],
    slots_per_point: int,
    seed: int,
    mcs_table: int = 1,
    n_cell_id: int = 1,
    cyclic_prefix: str = "normal",
    dmrs_config_type: int = 1,
    dmrs_additional_position: int = 0,
    channel_bandwidth_mhz: int | None = None,
    channel_mode: str = "normalized",
    ue_tx_power_dbm: float = 23.0,
    receiver_noise_figure_db: float = 7.0,
    progress: Callable[[float, str], None] = lambda f, m: None,
) -> dict:
    """Sweep the NR PUSCH chain over normalized or physical RT channel.

    ``cir`` is ``solve_cir`` output (``a``, ``tau`` and the OFDM grid metadata).
    Normalized mode sweeps absolute Eb/N0 values on a unit-mean-energy CFR.
    Absolute mode uses the unnormalized CFR and derives receiver noise from the
    UE conducted Tx power, occupied bandwidth and BS receiver NF. In that mode
    ``snr_points_db`` are offsets from the resulting physical link-budget Eb/N0;
    zero offset is the absolute operating point. Runs on CPU, outside RT lock.
    """
    import numpy as np
    import sionna.phy
    sionna.phy.config.device = "cpu"   # GPU stays exclusive to the RT solver
    sionna.phy.config.seed = int(seed)  # reproducible noise/payloads
    import os
    import torch
    # Avoid letting a CPU-bound PHY sweep monopolize every Colab vCPU. Keeping
    # some scheduling headroom makes FastAPI status polling responsive while
    # the sweep continues in its background thread.
    cpu_count = os.cpu_count() or 2
    try:
        torch.set_num_threads(max(1, min(4, cpu_count // 2)))
    except RuntimeError:
        # Keep the process-wide setting if PyTorch has already started work.
        pass
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        # PyTorch only permits changing inter-op threads before parallel work
        # has started; the intra-op cap above still applies in that case.
        pass
    from sionna.phy.channel import (ApplyOFDMChannel, cir_to_ofdm_channel,
                                    subcarrier_frequencies)
    from sionna.phy.nr import PUSCHConfig, PUSCHReceiver, PUSCHTransmitter
    from sionna.phy.utils import ebnodb2no

    a = np.asarray(cir["a"])
    tau = np.asarray(cir["tau"], dtype=float)
    if a.ndim != 6:
        raise ValueError(f"Expected 6-D CIR coefficients, got shape {a.shape}")
    num_paths = int(a.shape[-2])
    if num_paths == 0:
        raise ValueError("No ray-traced path reaches the receiver — "
                         "there is no channel to sweep")

    progress(0.02, "Configuring PUSCH chain")
    from .nr_config import (
        approximate_minimum_cp_seconds,
        build_sweep_points,
        validate_mcs_index,
    )

    scs_hz = int(round(float(cir["subcarrier_spacing"])))
    if scs_hz not in (15_000, 30_000, 60_000):
        raise ValueError("PUSCH FR1 sweep supports 15, 30, or 60 kHz SCS")
    validate_mcs_index(int(mcs_table), int(mcs_index))
    if cyclic_prefix == "extended" and scs_hz != 60_000:
        raise ValueError("Extended cyclic prefix is only valid at 60 kHz SCS")
    if channel_mode not in ("normalized", "absolute"):
        raise ValueError("channel_mode must be 'normalized' or 'absolute'")
    sweep_values = build_sweep_points(
        float(snr_points_db[0]), float(snr_points_db[-1]),
        float(snr_points_db[1] - snr_points_db[0]) if len(snr_points_db) > 1 else 1.0,
    ) if snr_points_db else []
    if not sweep_values:
        raise ValueError("At least one Eb/N0 sweep point is required")
    if len(sweep_values) != len(snr_points_db) or any(
        not math.isclose(a, float(b), abs_tol=1e-7)
        for a, b in zip(sweep_values, snr_points_db)
    ):
        raise ValueError("snr_points_db must be an ordered, evenly spaced sweep")

    pc = PUSCHConfig()
    pc.carrier.n_size_grid = int(num_prb)
    pc.carrier.subcarrier_spacing = scs_hz // 1000
    pc.carrier.n_cell_id = int(n_cell_id)
    pc.carrier.cyclic_prefix = str(cyclic_prefix)
    pc.num_antenna_ports = 1
    pc.num_layers = 1
    pc.dmrs.config_type = int(dmrs_config_type)
    pc.dmrs.additional_position = int(dmrs_additional_position)
    pc.tb.mcs_table = int(mcs_table)
    pc.tb.mcs_index = int(mcs_index)
    tx_blk = PUSCHTransmitter(pc, device="cpu")
    rx_blk = PUSCHReceiver(tx_blk, return_tb_crc_status=True, device="cpu")
    apply_ch = ApplyOFDMChannel(device="cpu")

    num_sc = 12 * pc.carrier.n_size_grid
    num_sym = pc.carrier.num_symbols_per_slot
    freqs = subcarrier_frequencies(num_sc, pc.carrier.subcarrier_spacing * 1e3)

    # Reciprocal single-stream uplink. This adapter swaps device/array roles
    # and combines UE array ports while preserving every ray-path tap.
    a_ul, tau_ul, num_ue_array_ports = _prepare_reciprocal_ul_cir(a, tau)
    # CIR tensors may include zero-padded path slots. Exclude those from the
    # reported path count and CP-delay diagnostic while preserving the native
    # tensor shape passed to Sionna's channel conversion.
    active_path_power = np.sum(np.abs(a_ul) ** 2, axis=(0, 1, 2, 3, 4, 6))
    active_path_mask = active_path_power > 0.0
    if not np.any(active_path_mask):
        raise ValueError("The ray tracer returned no non-zero CIR path coefficients")
    active_delays = tau_ul[0, 0, 0, active_path_mask]
    max_excess_delay_ns = max(0.0, float(np.max(active_delays) - np.min(active_delays)) * 1e9)
    active_path_count = int(np.count_nonzero(active_path_mask))
    a_t = torch.as_tensor(a_ul, dtype=torch.complex64)
    tau_t = torch.as_tensor(tau_ul, dtype=torch.float32)

    # Normalized mode isolates channel selectivity. Absolute mode deliberately
    # preserves the native RT path gain so the UE power and BS noise figure can
    # determine the actual operating SNR.
    h = cir_to_ofdm_channel(
        freqs, a_t, tau_t, normalize=(channel_mode == "normalized")
    )
    if h.ndim != 7 or h.shape[1] != 1 or h.shape[3] != 1 or h.shape[4] != 1:
        raise ValueError(f"Unexpected reciprocal PUSCH CFR layout: {tuple(h.shape)}")
    if h.shape[-1] != num_sc:
        raise ValueError(f"CFR has {h.shape[-1]} subcarriers; PUSCH grid requires {num_sc}")
    if h.shape[-2] == 1:  # static link: tile the single time step over the slot
        h = h.expand(*h.shape[:-2], num_sym, h.shape[-1])
    elif h.shape[-2] != num_sym:
        raise ValueError(
            f"CIR has {h.shape[-2]} time samples but the PUSCH slot has {num_sym} symbols; "
            "this release does not resample time-varying RT channels"
        )

    bits_per_symbol = int(torch.as_tensor(pc.tb.num_bits_per_symbol).reshape(-1)[0])
    coderate = float(torch.as_tensor(pc.tb.target_coderate).reshape(-1)[0])
    numerology = {15: 0, 30: 1, 60: 2}[int(pc.carrier.subcarrier_spacing)]
    slot_duration_seconds = 1e-3 / (2 ** numerology)

    link_budget: dict | None = None
    if channel_mode == "absolute":
        # Sum independent BS receive-port signal powers, then average across
        # the PUSCH frequency/time grid. UE array ports were already combined
        # with a unit-norm precoder in _prepare_reciprocal_ul_cir().
        mean_gain = float(
            torch.sum(torch.abs(h) ** 2, dim=(2, 4)).mean().detach().cpu().item()
        )
        occupied_bandwidth_hz = float(num_sc * scs_hz)
        link_budget = _absolute_link_budget(
            mean_channel_gain=mean_gain,
            ue_tx_power_dbm=float(ue_tx_power_dbm),
            occupied_bandwidth_hz=occupied_bandwidth_hz,
            receiver_noise_figure_db=float(receiver_noise_figure_db),
            bits_per_symbol=bits_per_symbol,
            coderate=coderate,
        )

    points: list[dict] = []
    total = len(snr_points_db)
    for k, sweep_value_db in enumerate(snr_points_db):
        if channel_mode == "normalized":
            ebno_db = float(sweep_value_db)
            progress(0.05 + 0.95 * k / total,
                     f"Eb/N0 {ebno_db:g} dB ({k + 1}/{total})")
            no = torch.as_tensor(ebnodb2no(ebno_db, bits_per_symbol, coderate))
            link_budget_offset_db = None
        else:
            assert link_budget is not None
            link_budget_offset_db = float(sweep_value_db)
            ebno_db = float(link_budget["linkBudgetEbNoDb"] + link_budget_offset_db)
            progress(
                0.05 + 0.95 * k / total,
                f"Link-budget offset {link_budget_offset_db:+g} dB "
                f"(effective Eb/N0 {ebno_db:.2f} dB; {k + 1}/{total})",
            )
            # Positive offset means a correspondingly lower noise variance;
            # offset=0 preserves the physical thermal-noise operating point.
            no_value = float(link_budget["noiseVariance"]) * 10.0 ** (-link_budget_offset_db / 10.0)
            if not math.isfinite(no_value) or no_value <= 0.0:
                raise ValueError("Absolute-mode noise variance is not finite and positive")
            no = torch.as_tensor(no_value, dtype=torch.float32, device="cpu")
        # Process slots in bounded batches. This limits peak CPU memory and
        # reports progress during a large point instead of appearing frozen
        # until all slots at that Eb/N0 have completed.
        slot_batches = _slot_batch_sizes(int(slots_per_point), batch_size=16)
        bit_errors = 0
        bits = 0
        block_errors = 0
        blocks = 0
        point_progress_start = 0.05 + 0.95 * k / total
        point_progress_width = 0.95 / total
        processed_slots = 0
        for batch_index, batch_slots in enumerate(slot_batches):
            x, b = tx_blk(int(batch_slots))
            hb = h.expand(int(batch_slots), *h.shape[1:])
            y = apply_ch(x, hb, no)
            b_hat, crc = rx_blk(y, no)
            batch_bits = int(b.numel())
            batch_blocks = int(crc.numel())
            if batch_bits <= 0 or batch_blocks <= 0:
                raise RuntimeError("PUSCH receiver returned an empty bit or transport-block batch")
            bit_errors += int((b != b_hat).sum())
            bits += batch_bits
            block_errors += int((~crc.bool()).sum())
            blocks += batch_blocks
            processed_slots += int(batch_slots)
            fraction_in_point = (batch_index + 1) / len(slot_batches)
            progress(
                point_progress_start + point_progress_width * fraction_in_point,
                (f"Eb/N0 {ebno_db:g} dB ({k + 1}/{total}); "
                 f"processed {processed_slots}/{slots_per_point} slots"),
            )
        if bits <= 0 or blocks <= 0:
            raise RuntimeError("PUSCH receiver returned an empty bit or transport-block batch")
        ber = bit_errors / bits
        bler = block_errors / blocks
        ber_ci = _wilson_interval(bit_errors, bits)
        bler_ci = _wilson_interval(block_errors, blocks)
        points.append({
            "ebNoDb": float(ebno_db),
            "linkBudgetOffsetDb": link_budget_offset_db,
            "ber": ber,
            "bler": bler,
            "berCi95Lower": ber_ci[0],
            "berCi95Upper": ber_ci[1],
            "blerCi95Lower": bler_ci[0],
            "blerCi95Upper": bler_ci[1],
            "goodputMbps": max(0, blocks - block_errors) * int(torch.as_tensor(pc.tb_size).reshape(-1)[0])
                / (int(slots_per_point) * slot_duration_seconds * 1e6),
            "bitErrors": bit_errors, "bits": bits,
            "blockErrors": block_errors, "blocks": blocks,
        })

    progress(1.0, "Done")
    return {
        "points": points,
        "mcsIndex": int(mcs_index),
        "mcsTable": int(mcs_table),
        "modulationOrder": bits_per_symbol,
        "targetCoderate": coderate,
        "numPrb": int(num_prb),
        "numSubcarriers": num_sc,
        "subcarrierSpacingHz": pc.carrier.subcarrier_spacing * 1e3,
        "channelBandwidthMHz": channel_bandwidth_mhz,
        "occupiedBandwidthHz": int(num_sc * pc.carrier.subcarrier_spacing * 1e3),
        "nCellId": int(n_cell_id),
        "cyclicPrefix": str(cyclic_prefix),
        "dmrsConfigType": int(dmrs_config_type),
        "dmrsAdditionalPosition": int(dmrs_additional_position),
        "numSymbolsPerSlot": int(pc.carrier.num_symbols_per_slot),
        "slotDurationSeconds": float(1e-3 / (2 ** {15: 0, 30: 1, 60: 2}[int(pc.carrier.subcarrier_spacing)])),
        "maxExcessDelayNs": max_excess_delay_ns,
        "approxMinimumCpNs": approximate_minimum_cp_seconds(
            int(pc.carrier.subcarrier_spacing) * 1000, str(cyclic_prefix)
        ) * 1e9,
        "channelMode": channel_mode,
        "sweepAxis": "ebno" if channel_mode == "normalized" else "link_budget_offset",
        "linkBudgetEbNoDb": None if link_budget is None else float(link_budget["linkBudgetEbNoDb"]),
        "effectiveSnrDb": None if link_budget is None else float(link_budget["effectiveSnrDb"]),
        "rxPowerDbm": None if link_budget is None else float(link_budget["combinedRxPowerDbm"]),
        "noisePowerDbm": None if link_budget is None else float(link_budget["noisePowerDbm"]),
        "noiseBandwidthHz": None if link_budget is None else float(link_budget["noiseBandwidthHz"]),
        "meanChannelGainDb": None if link_budget is None else float(link_budget["meanChannelGainDb"]),
        "ueTxPowerDbm": None if link_budget is None else float(ue_tx_power_dbm),
        "receiverNoiseFigureDb": None if link_budget is None else float(receiver_noise_figure_db),
        "noiseTemperatureK": None if link_budget is None else float(link_budget["noiseTemperatureK"]),
        "channelNormalized": channel_mode == "normalized",
        "channelDirection": "reciprocal_uplink",
        "interferenceModel": "single_link_awgn_no_inter_cell_interference",
        "numRxAnt": int(a_ul.shape[2]),   # base-station elements (uplink Rx)
        "numTxAnt": 1,                    # one effective PUSCH stream
        "numUeArrayPorts": num_ue_array_ports,
        "numPaths": active_path_count,
        "slotsPerPoint": int(slots_per_point),
        "transportBlockBits": int(torch.as_tensor(pc.tb_size).reshape(-1)[0]),
        "seed": int(seed),
    }
