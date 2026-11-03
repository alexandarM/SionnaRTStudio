"""Validated 5G NR FR1 resource-grid helpers.

The bandwidth-to-PRB mapping follows 3GPP TS 38.104 Table 5.3.2-1.
Only FR1 configurations with 15/30/60 kHz SCS are exposed in this release.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


# TS 38.104, Table 5.3.2-1 (FR1). Keys are nominal channel bandwidth in MHz;
# values are maximum transmission bandwidth configurations in resource blocks.
_FR1_PRBS: dict[int, dict[int, int]] = {
    15: {5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 35: 188,
         40: 216, 45: 242, 50: 270},
    30: {5: 11, 10: 24, 15: 38, 20: 51, 25: 65, 30: 78, 35: 92,
         40: 106, 45: 119, 50: 133, 60: 162, 70: 189, 80: 217,
         90: 245, 100: 273},
    60: {10: 11, 15: 18, 20: 24, 25: 31, 30: 38, 35: 44, 40: 51,
         45: 58, 50: 65, 60: 79, 70: 93, 80: 107, 90: 121, 100: 135},
}


@dataclass(frozen=True)
class NRResourceGrid:
    channel_bandwidth_mhz: int
    subcarrier_spacing_hz: int
    num_prb: int
    num_subcarriers: int
    occupied_bandwidth_hz: int
    slot_duration_seconds: float
    numerology: int


def resolve_fr1_resource_grid(
    channel_bandwidth_mhz: int,
    subcarrier_spacing_hz: int,
) -> NRResourceGrid:
    """Resolve a standards-table FR1 channel configuration to its PRB grid."""
    try:
        bandwidth = int(channel_bandwidth_mhz)
        scs_hz = int(subcarrier_spacing_hz)
    except (TypeError, ValueError) as exc:
        raise ValueError("Channel bandwidth and SCS must be integers") from exc

    scs_khz = scs_hz // 1000
    if scs_hz not in (15_000, 30_000, 60_000):
        raise ValueError("FR1 SCS must be 15, 30, or 60 kHz in this release")
    prb = _FR1_PRBS[scs_khz].get(bandwidth)
    if prb is None:
        allowed = ", ".join(str(v) for v in sorted(_FR1_PRBS[scs_khz]))
        raise ValueError(
            f"Unsupported FR1 combination: {bandwidth} MHz at "
            f"{scs_hz // 1000} kHz SCS. Allowed bandwidths: {allowed} MHz"
        )

    numerology = {15_000: 0, 30_000: 1, 60_000: 2}[scs_hz]
    num_subcarriers = 12 * prb
    return NRResourceGrid(
        channel_bandwidth_mhz=bandwidth,
        subcarrier_spacing_hz=scs_hz,
        num_prb=prb,
        num_subcarriers=num_subcarriers,
        occupied_bandwidth_hz=num_subcarriers * scs_hz,
        slot_duration_seconds=1e-3 / (2**numerology),
        numerology=numerology,
    )


def validate_mcs_index(mcs_table: int, mcs_index: int) -> None:
    """Validate MCS index ranges supported by the Sionna NR tables 1–3."""
    if mcs_table not in (1, 2, 3):
        raise ValueError("MCS table must be 1, 2, or 3 in this release")
    max_index = 27 if mcs_table == 2 else 28
    if not 0 <= mcs_index <= max_index:
        raise ValueError(
            f"MCS index for table {mcs_table} must be in range 0..{max_index}"
        )


def build_sweep_points(
    start_db: float,
    stop_db: float,
    step_db: float,
    *,
    max_points: int = 41,
) -> list[float]:
    """Build a deterministic, decimal-safe Eb/N0/offset sweep.

    The stop value must land exactly on the selected step. This avoids silently
    omitting a user-requested endpoint due to floating-point accumulation.
    Half-dB steps are supported.
    """
    values = (float(start_db), float(stop_db), float(step_db))
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Sweep bounds and step must be finite numbers")
    start, stop, step = values
    if step <= 0.0:
        raise ValueError("Sweep step must be greater than zero")
    if stop < start:
        raise ValueError("Sweep stop must be greater than or equal to start")

    span_steps = (stop - start) / step
    rounded_steps = round(span_steps)
    if not math.isclose(span_steps, rounded_steps, rel_tol=1e-9, abs_tol=1e-8):
        raise ValueError("Sweep range must be exactly divisible by the selected step")
    count = int(rounded_steps) + 1
    if count > int(max_points):
        raise ValueError(f"Sweep is limited to {max_points} points")
    # Decimal rounding keeps values such as -0.5 and 0.5 stable in JSON/UI keys.
    return [round(start + index * step, 9) for index in range(count)]


def approximate_minimum_cp_seconds(scs_hz: int, cyclic_prefix: str) -> float:
    """Conservative nominal CP duration for a simple excess-delay warning.

    This is a coarse FR1 check, not a per-symbol CP/ISI/ICI waveform model.
    Normal CP uses the approximate shortest regular-symbol CP; extended CP is
    supported only at 60 kHz in NR FR1.
    """
    if cyclic_prefix == "extended":
        if scs_hz != 60_000:
            raise ValueError("Extended cyclic prefix is only supported at 60 kHz SCS")
        return 4.1666666667e-6
    if cyclic_prefix != "normal":
        raise ValueError("Cyclic prefix must be 'normal' or 'extended'")
    if scs_hz not in (15_000, 30_000, 60_000):
        raise ValueError("Unsupported SCS for FR1 cyclic-prefix check")
    return 4.7e-6 * (15_000 / scs_hz)
