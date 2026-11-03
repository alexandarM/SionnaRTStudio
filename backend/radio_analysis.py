"""Radio-map analytics derived from Sionna RT outputs.

The functions in this module deliberately do not emulate a cellular PHY.
They post-process Sionna's native path_gain, rss, and sinr tensors and label
all additional quantities as derived metrics.
"""
from __future__ import annotations

from typing import Any
import math
import numpy as np

BOLTZMANN_J_K = 1.380649e-23
# Finite display limits for exact zero-interference / no-detected-neighbour
# cases. They represent limiting values, not measured powers or finite ratios.
ZERO_POWER_DBM_FLOOR = -300.0
NO_INTERFERENCE_RATIO_CEILING_DB = 300.0

METRIC_UNITS = {
    "power": "dBm",
    "path_gain": "dB",
    "path_loss": "dB",
    "sinr": "dB",
    "best_sinr": "dB",
    "interference": "dBm",
    "sir": "dB",
    "inr": "dB",
    "dominance": "dB",
}

LOWER_IS_BETTER = {"path_loss", "interference", "inr"}

DEFAULT_THRESHOLDS = {
    "power": -90.0,
    "path_gain": -110.0,
    "path_loss": 110.0,
    "sinr": 0.0,
    "best_sinr": 0.0,
    "interference": -100.0,
    "sir": 0.0,
    "inr": -10.0,
    "dominance": 6.0,
}


def watts_to_dbm(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 10.0 * np.log10(values) + 30.0
    return np.where(np.isfinite(out), out, np.nan)


def linear_to_db(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 10.0 * np.log10(values)
    return np.where(np.isfinite(out), out, np.nan)


def _summary(
    values: np.ndarray,
    threshold: float,
    cell_area_m2: float,
    lower_is_better: bool = False,
) -> dict[str, Any]:
    """Summarize values against the full map area, not only reachable cells.

    ``lower_is_better`` flips the pass condition for path loss and interference
    metrics. All probability denominators remain the full rectangular grid.
    """
    values = np.asarray(values, dtype=np.float64).reshape(-1)
    total = int(values.size)
    finite_mask = np.isfinite(values)
    finite = values[finite_mask]
    reachable_count = int(finite.size)
    if lower_is_better:
        served_mask = finite_mask & (values <= float(threshold))
    else:
        served_mask = finite_mask & (values >= float(threshold))
    served_count = int(served_mask.sum())
    q = [5, 10, 25, 50, 75, 90, 95]
    if reachable_count:
        qs = np.percentile(finite, q).astype(float).tolist()
        mean = float(np.mean(finite))
        std = float(np.std(finite))
        minimum, maximum = float(np.min(finite)), float(np.max(finite))
        # 21 quantile points form a compact empirical CDF that is sufficient for
        # a UI curve and avoids shipping every map-cell value in JSON.
        cdf = [
            {"percentile": float(p), "value": float(v)}
            for p, v in zip(np.linspace(0, 100, 21), np.percentile(finite, np.linspace(0, 100, 21)))
        ]
        if float(np.max(finite)) - float(np.min(finite)) <= 1e-12:
            center = float(finite[0])
            hist_edges = np.linspace(center - 0.5, center + 0.5, 21)
            hist_counts, _ = np.histogram(finite, bins=hist_edges)
        else:
            hist_counts, hist_edges = np.histogram(finite, bins=20)
        histogram = [
            {"binStart": float(hist_edges[i]), "binEnd": float(hist_edges[i + 1]),
             "count": int(hist_counts[i]), "percent": float(100.0 * hist_counts[i] / max(reachable_count, 1))}
            for i in range(len(hist_counts))
        ]
    else:
        qs = [None] * len(q)
        mean = std = minimum = maximum = None
        cdf = []
        histogram = []
    total_area = total * float(cell_area_m2)
    served_area = served_count * float(cell_area_m2)
    return {
        "count": total,
        "reachableCount": reachable_count,
        "reachablePercent": 100.0 * reachable_count / max(total, 1),
        "servedCount": served_count,
        "servedPercent": 100.0 * served_count / max(total, 1),
        "outagePercent": 100.0 - (100.0 * served_count / max(total, 1)),
        "thresholdDb": float(threshold),
        "thresholdComparison": "at_or_below" if lower_is_better else "at_or_above",
        "mean": mean,
        "std": std,
        "min": minimum,
        "max": maximum,
        "p5": qs[0], "p10": qs[1], "p25": qs[2], "p50": qs[3],
        "p75": qs[4], "p90": qs[5], "p95": qs[6],
        "cellAreaM2": float(cell_area_m2),
        "totalAreaKm2": total_area / 1e6,
        "servedAreaKm2": served_area / 1e6,
        "cdf": cdf,
        "histogram": histogram,
    }


def compute_radio_map_analytics(
    path_gain_w: np.ndarray,
    rss_w: np.ndarray,
    sinr_linear: np.ndarray,
    tx_metadata: list[dict[str, Any]],
    bandwidth_hz: float,
    temperature_k: float,
    cell_area_m2: float,
    metric: str = "power",
    threshold: float | None = None,
    rss_threshold_dbm: float = -100.0,
    sinr_threshold_db: float = 0.0,
) -> dict[str, Any]:
    """Compute best-server and per-transmitter radio KPIs.

    ``path_gain_w``, ``rss_w`` and ``sinr_linear`` are native Sionna outputs,
    shaped [num_tx, num_cells]. RSS is power in watts; SINR is linear.
    """
    if metric not in METRIC_UNITS:
        raise ValueError(f"Unsupported radio-map metric: {metric}")
    pg = np.asarray(path_gain_w, dtype=np.float64)
    rss = np.asarray(rss_w, dtype=np.float64)
    sinr = np.asarray(sinr_linear, dtype=np.float64)
    if pg.ndim != 2 or rss.ndim != 2 or sinr.ndim != 2:
        raise ValueError("Radio-map arrays must be [num_tx, num_cells]")
    if pg.shape != rss.shape or rss.shape != sinr.shape:
        raise ValueError("path_gain, RSS, and SINR arrays must have matching shapes")
    n_tx, n_cells = rss.shape
    if n_tx != len(tx_metadata):
        raise ValueError("Transmitter metadata count does not match radio-map tensors")
    if n_tx < 1 or n_cells < 1:
        raise ValueError("Radio map must contain at least one transmitter and one cell")

    rss_dbm = watts_to_dbm(rss)
    path_gain_db = linear_to_db(pg)
    sinr_db = linear_to_db(sinr)
    rss_dbm[~np.isfinite(rss_dbm)] = -np.inf
    path_gain_db[~np.isfinite(path_gain_db)] = np.nan
    sinr_db[~np.isfinite(sinr_db)] = np.nan

    # These associations are the per-cell argmax of Sionna's native per-TX
    # RadioMap layers. They are numerically equivalent to tx_association for
    # the corresponding metric, while also allowing an explicit -1 for cells
    # where no finite/positive value exists in the transferred tensor.
    cell_index = np.arange(n_cells)
    best_rss_tx_raw = np.argmax(rss_dbm, axis=0).astype(np.int32)
    best_rss_dbm = rss_dbm[best_rss_tx_raw, cell_index]
    reachable_any = np.isfinite(best_rss_dbm)
    best_rss_tx = np.where(reachable_any, best_rss_tx_raw, -1).astype(np.int32)
    serving_path_gain_db = path_gain_db[best_rss_tx_raw, cell_index]
    best_sinr_db = sinr_db[best_rss_tx_raw, cell_index]

    path_gain_safe = np.where(np.isfinite(path_gain_db), path_gain_db, -np.inf)
    best_path_gain_tx_raw = np.argmax(path_gain_safe, axis=0).astype(np.int32)
    max_path_gain_db = path_gain_safe[best_path_gain_tx_raw, cell_index]
    best_path_gain_tx = np.where(np.isfinite(max_path_gain_db), best_path_gain_tx_raw, -1).astype(np.int32)
    sinr_safe = np.where(np.isfinite(sinr_db), sinr_db, -np.inf)
    best_sinr_tx_raw = np.argmax(sinr_safe, axis=0).astype(np.int32)
    max_sinr_db = sinr_safe[best_sinr_tx_raw, cell_index]
    best_sinr_tx = np.where(np.isfinite(max_sinr_db), best_sinr_tx_raw, -1).astype(np.int32)
    best_rss_w = best_rx_w_safe(rss, n_cells)

    if n_tx > 1:
        sorted_rss = np.sort(rss_dbm, axis=0)
        second_best_dbm = sorted_rss[-2]
        with np.errstate(invalid="ignore"):
            dominance = best_rss_dbm - second_best_dbm
        dominance[np.isposinf(dominance)] = NO_INTERFERENCE_RATIO_CEILING_DB
        total_rx_w = np.sum(np.where(np.isfinite(rss), rss, 0.0), axis=0)
        best_rx_w = np.max(np.where(np.isfinite(rss), rss, 0.0), axis=0)
        interference_w = np.maximum(total_rx_w - best_rx_w, 0.0)
        competing_sector_count = np.sum(rss_dbm >= float(rss_threshold_dbm), axis=0).astype(np.int16)
    else:
        second_best_dbm = np.full(n_cells, -np.inf)
        dominance = np.where(np.isfinite(best_rss_dbm), NO_INTERFERENCE_RATIO_CEILING_DB, np.nan)
        interference_w = np.zeros(n_cells, dtype=np.float64)
        competing_sector_count = np.where(np.isfinite(best_rss_dbm) & (best_rss_dbm >= float(rss_threshold_dbm)), 1, 0).astype(np.int16)

    noise_w = BOLTZMANN_J_K * max(float(temperature_k), 0.0) * max(float(bandwidth_hz), 0.0)
    rss_clean = _positive_finite(rss)
    # Strongest non-serving sector in each cell (the first-ranked interferer).
    competitor = rss_clean.copy()
    safe_best_idx = np.where(best_rss_tx >= 0, best_rss_tx, 0)
    competitor[safe_best_idx, cell_index] = 0.0
    top_interferer_tx_raw = np.argmax(competitor, axis=0).astype(np.int32)
    top_interferer_w = competitor[top_interferer_tx_raw, cell_index]
    top_interferer_tx = np.where((top_interferer_w > 0.0) & (best_rss_tx >= 0), top_interferer_tx_raw, -1).astype(np.int32)
    with np.errstate(divide="ignore", invalid="ignore"):
        top_interference_share = np.where(interference_w > 0.0, top_interferer_w / interference_w, 0.0)
    interference_dbm = watts_to_dbm(interference_w)
    with np.errstate(divide="ignore", invalid="ignore"):
        sir_db = linear_to_db(best_rx_w_safe(rss, n_cells) / np.maximum(interference_w, 1e-300))
        inr_db = linear_to_db(interference_w / max(noise_w, 1e-300))
    # At exactly zero interference the ratios have limiting values (+inf SIR,
    # -inf INR). Use explicit finite display bounds to keep heatmaps/JSON valid.
    no_interference = interference_w <= 0.0
    interference_dbm[no_interference] = ZERO_POWER_DBM_FLOOR
    sir_db[no_interference & (best_rss_w > 0.0)] = NO_INTERFERENCE_RATIO_CEILING_DB
    sir_db[no_interference & (best_rss_w <= 0.0)] = np.nan
    inr_db[no_interference] = ZERO_POWER_DBM_FLOOR

    overlap_percent = 100.0 * float(np.mean(competing_sector_count >= 2))
    mean_competing = float(np.mean(competing_sector_count))
    values_by_metric = {
        "power": best_rss_dbm,
        "path_gain": max_path_gain_db,
        "path_loss": -max_path_gain_db,
        "sinr": best_sinr_db,
        "best_sinr": max_sinr_db,
        "interference": interference_dbm,
        "sir": sir_db,
        "inr": inr_db,
        "dominance": dominance,
    }
    selected_threshold = DEFAULT_THRESHOLDS[metric] if threshold is None else float(threshold)
    overall = _summary(
        values_by_metric[metric], selected_threshold, cell_area_m2,
        lower_is_better=metric in LOWER_IS_BETTER,
    )
    overall.update({
        "metric": metric,
        "unit": METRIC_UNITS[metric],
        # Mean received/interference power is averaged in linear watts first,
        # then converted to dBm. Percentiles remain quantiles of dBm samples.
        "meanRssDbm": float(watts_to_dbm(np.array([np.mean(best_rss_w[reachable_any])]))[0]) if reachable_any.any() else None,
        "meanPathGainDb": float(np.nanmean(max_path_gain_db)) if np.isfinite(max_path_gain_db).any() else None,
        # Spatial mean of per-cell SINR values expressed in dB (not mean linear SINR).
        "meanSinrDb": float(np.nanmean(best_sinr_db)) if np.isfinite(best_sinr_db).any() else None,
        "meanBestSinrDb": float(np.nanmean(max_sinr_db)) if np.isfinite(max_sinr_db).any() else None,
        "meanInterferenceDbm": float(watts_to_dbm(np.array([np.mean(interference_w)]))[0]) if np.any(interference_w > 0.0) else None,
        "noisePowerDbm": float(10.0 * math.log10(noise_w) + 30.0) if noise_w > 0 else None,
        "overlapPercent": overlap_percent,
        "meanCompetingSectors": mean_competing,
        "overlapRssThresholdDbm": float(rss_threshold_dbm),
    })

    leave_one_out = compute_leave_one_out_analytics(
        rss, noise_w, cell_area_m2, tx_metadata,
        rss_threshold_dbm=rss_threshold_dbm,
        sinr_threshold_db=sinr_threshold_db,
    )
    tx_stats = []
    for i, meta in enumerate(tx_metadata):
        tx_rss = rss_dbm[i]
        tx_sinr = sinr_db[i]
        tx_pg = path_gain_db[i]
        rss_summary = _summary(tx_rss, rss_threshold_dbm, cell_area_m2)
        sinr_summary = _summary(tx_sinr, sinr_threshold_db, cell_area_m2)
        pg_summary = _summary(tx_pg, -110.0, cell_area_m2)
        tx_rss_reachable = np.isfinite(tx_rss)
        mean_tx_rss_dbm = None
        if tx_rss_reachable.any():
            tx_mean_w = float(np.mean(rss_clean[i, tx_rss_reachable]))
            mean_tx_rss_dbm = float(watts_to_dbm(np.array([tx_mean_w]))[0])
        serving_count = int(np.sum(best_rss_tx == i))
        sinr_association_count = int(np.sum(best_sinr_tx == i))
        path_gain_association_count = int(np.sum(best_path_gain_tx == i))
        tx_interference_w = np.maximum(np.sum(rss_clean, axis=0) - rss_clean[i], 0.0)
        tx_interference_dbm = watts_to_dbm(tx_interference_w)
        tx_interference_dbm[tx_interference_w <= 0.0] = ZERO_POWER_DBM_FLOOR
        tx_snr_db = linear_to_db(rss_clean[i] / max(noise_w, 1e-300))
        tx_sir_db = linear_to_db(rss_clean[i] / np.maximum(tx_interference_w, 1e-300))
        tx_sir_db[(tx_interference_w <= 0.0) & (rss_clean[i] > 0.0)] = NO_INTERFERENCE_RATIO_CEILING_DB
        tx_inr_db = linear_to_db(tx_interference_w / max(noise_w, 1e-300))
        tx_inr_db[tx_interference_w <= 0.0] = ZERO_POWER_DBM_FLOOR
        mean_top_interferer_cells = int(np.sum(top_interferer_tx == i))
        top_power = top_interferer_w[top_interferer_tx == i]
        top_share = top_interference_share[top_interferer_tx == i]
        loo = leave_one_out[i]
        tx_stats.append({
            "txIndex": i,
            "txId": meta.get("id", f"tx_{i}"),
            "txName": meta.get("name", f"Tx {i + 1}"),
            "site": meta.get("site"),
            "frequencyBand": meta.get("frequencyBand"),
            "powerDbm": meta.get("powerDbm"),
            "meanRssDbm": mean_tx_rss_dbm,
            "rssStdDb": rss_summary["std"],
            "rssMinDbm": rss_summary["min"],
            "rssMaxDbm": rss_summary["max"],
            "rssP5Dbm": rss_summary["p5"],
            "rssP10Dbm": rss_summary["p10"],
            "rssP25Dbm": rss_summary["p25"],
            "rssP50Dbm": rss_summary["p50"],
            "rssP75Dbm": rss_summary["p75"],
            "rssP90Dbm": rss_summary["p90"],
            "rssP95Dbm": rss_summary["p95"],
            "meanSinrDb": sinr_summary["mean"],
            "sinrStdDb": sinr_summary["std"],
            "sinrMinDb": sinr_summary["min"],
            "sinrMaxDb": sinr_summary["max"],
            "sinrP5Db": sinr_summary["p5"],
            "sinrP10Db": sinr_summary["p10"],
            "sinrP25Db": sinr_summary["p25"],
            "sinrP50Db": sinr_summary["p50"],
            "sinrP75Db": sinr_summary["p75"],
            "sinrP90Db": sinr_summary["p90"],
            "sinrP95Db": sinr_summary["p95"],
            "meanPathGainDb": pg_summary["mean"],
            "pathGainP5Db": pg_summary["p5"],
            "pathGainP50Db": pg_summary["p50"],
            "pathGainP95Db": pg_summary["p95"],
            "meanSnrDb": float(np.nanmean(tx_snr_db)) if np.isfinite(tx_snr_db).any() else None,
            "meanInterferenceDbm": float(watts_to_dbm(np.array([np.mean(tx_interference_w)]))[0]) if np.any(tx_interference_w > 0.0) else None,
            "meanSirDb": float(np.nanmean(tx_sir_db)) if np.isfinite(tx_sir_db).any() else None,
            "meanInrDb": float(np.nanmean(tx_inr_db)) if np.isfinite(tx_inr_db).any() else None,
            "servingCellCount": serving_count,
            "servingPercent": 100.0 * serving_count / max(int(reachable_any.sum()), 1),
            "sinrAssociationCellCount": sinr_association_count,
            "sinrAssociationPercent": 100.0 * sinr_association_count / max(int(np.isfinite(max_sinr_db).sum()), 1),
            "pathGainAssociationCellCount": path_gain_association_count,
            "pathGainAssociationPercent": 100.0 * path_gain_association_count / max(int(np.isfinite(max_path_gain_db).sum()), 1),
            "rssReachablePercent": rss_summary["reachablePercent"],
            "rssCoverageThresholdDbm": float(rss_threshold_dbm),
            "rssCoveragePercent": rss_summary["servedPercent"],
            "rssCoverageAreaKm2": rss_summary["servedAreaKm2"],
            "sinrCoverageThresholdDb": float(sinr_threshold_db),
            "sinrCoveragePercent": sinr_summary["servedPercent"],
            "sinrCoverageAreaKm2": sinr_summary["servedAreaKm2"],
            "topInterfererCells": mean_top_interferer_cells,
            "topInterfererCellPercent": 100.0 * mean_top_interferer_cells / max(n_cells, 1),
            "meanTopInterferenceDbm": float(watts_to_dbm(np.array([np.mean(top_power)]))[0]) if top_power.size and np.mean(top_power) > 0 else None,
            "meanTopInterferenceSharePercent": float(100.0 * np.mean(top_share)) if top_share.size else 0.0,
            "leaveOneOut": loo,
        })

    # Site-level aggregation: strongest sector at each cell within a site.
    # This is an envelope/coverage view, not a sum of the site's sectors.
    site_groups: dict[str, list[int]] = {}
    for i, meta in enumerate(tx_metadata):
        site_name = str(meta.get("site") or meta.get("name") or meta.get("id") or f"Tx {i + 1}")
        site_groups.setdefault(site_name, []).append(i)

    site_stats = []
    for site_name, indices in site_groups.items():
        site_rss_dbm = rss_dbm[indices]
        site_best_local = np.argmax(site_rss_dbm, axis=0)
        site_best_global = np.asarray(indices, dtype=np.int32)[site_best_local]
        site_cell_idx = np.arange(n_cells)
        site_best_rss_dbm = site_rss_dbm[site_best_local, site_cell_idx]
        site_best_rss_w = np.max(np.where(np.isfinite(rss[indices]), rss[indices], 0.0), axis=0)
        site_reachable = np.isfinite(site_best_rss_dbm)
        site_best_sinr_db = sinr_db[site_best_global, site_cell_idx]
        site_best_pg_db = path_gain_db[site_best_global, site_cell_idx]
        site_rss_summary = _summary(site_best_rss_dbm, rss_threshold_dbm, cell_area_m2)
        site_sinr_summary = _summary(site_best_sinr_db, sinr_threshold_db, cell_area_m2)
        site_serving_count = int(np.sum(np.isin(best_rss_tx, indices) & reachable_any))
        site_mean_rss_dbm = None
        if site_reachable.any():
            site_mean_rss_dbm = float(watts_to_dbm(np.array([np.mean(site_best_rss_w[site_reachable])]))[0])
        site_stats.append({
            "site": site_name,
            "sectorCount": len(indices),
            "meanRssDbm": site_mean_rss_dbm,
            "meanSinrDb": float(np.nanmean(site_best_sinr_db)) if np.isfinite(site_best_sinr_db).any() else None,
            "meanPathGainDb": float(np.nanmean(site_best_pg_db)) if np.isfinite(site_best_pg_db).any() else None,
            "rssP5Dbm": site_rss_summary["p5"],
            "rssP50Dbm": site_rss_summary["p50"],
            "rssP95Dbm": site_rss_summary["p95"],
            "servingCellCount": site_serving_count,
            "servingPercent": 100.0 * site_serving_count / max(int(reachable_any.sum()), 1),
            "rssCoveragePercent": site_rss_summary["servedPercent"],
            "rssCoverageAreaKm2": site_rss_summary["servedAreaKm2"],
            "sinrCoveragePercent": site_sinr_summary["servedPercent"],
            "sinrCoverageAreaKm2": site_sinr_summary["servedAreaKm2"],
        })

    selected = values_by_metric[metric]
    return {
        "bestRssTx": best_rss_tx.astype(np.int32),
        "bestSinrTx": best_sinr_tx.astype(np.int32),
        "bestSinrMaxDb": max_sinr_db.astype(np.float32),
        "bestRssDbm": best_rss_dbm.astype(np.float32),
        "bestPathGainTx": best_path_gain_tx.astype(np.int32),
        "bestPathGainDb": max_path_gain_db.astype(np.float32),
        "bestPathLossDb": (-max_path_gain_db).astype(np.float32),
        "servingPathGainDb": serving_path_gain_db.astype(np.float32),
        "bestSinrDb": best_sinr_db.astype(np.float32),
        "competingSectorCount": competing_sector_count,
        "interferenceDbm": interference_dbm.astype(np.float32),
        "sirDb": sir_db.astype(np.float32),
        "inrDb": inr_db.astype(np.float32),
        "dominanceMarginDb": dominance.astype(np.float32),
        "topInterfererTx": top_interferer_tx.astype(np.int32),
        "topInterfererPowerDbm": watts_to_dbm(top_interferer_w).astype(np.float32),
        "topInterferenceSharePercent": (100.0 * top_interference_share).astype(np.float32),
        "metricValues": np.asarray(selected, dtype=np.float32),
        "stats": overall,
        "txStats": tx_stats,
        "siteStats": site_stats,
        "noisePowerDbm": overall["noisePowerDbm"],
    }


def best_rx_w_safe(rss: np.ndarray, n_cells: int) -> np.ndarray:
    """Return the strongest RSS power (W) at each cell."""
    cleaned = np.where(np.isfinite(rss), rss, 0.0)
    if cleaned.shape[0] == 0:
        return np.zeros(n_cells, dtype=np.float64)
    return np.max(cleaned, axis=0)



def _positive_finite(values: np.ndarray) -> np.ndarray:
    """Return a finite, non-negative linear-power/gain array."""
    a = np.asarray(values, dtype=np.float64)
    return np.where(np.isfinite(a) & (a > 0.0), a, 0.0)


def compute_leave_one_out_analytics(
    rss_w: np.ndarray,
    noise_power_w: float,
    cell_area_m2: float,
    tx_metadata: list[dict[str, Any]],
    rss_threshold_dbm: float = -100.0,
    sinr_threshold_db: float = 0.0,
) -> list[dict[str, Any]]:
    """Compute static full-buffer leave-one-TX-out counterfactuals.

    This is an algebraic interference-only counterfactual using the original
    per-TX Sionna RSS layers. It does not rerun ray tracing and assumes that
    removing one TX does not change propagation, scheduling, or the power of
    any remaining TX. The strongest remaining RSS becomes the server.
    """
    rss = _positive_finite(rss_w)
    if rss.ndim != 2:
        raise ValueError("RSS must be [num_tx, num_cells]")
    n_tx, n_cells = rss.shape
    if n_tx != len(tx_metadata):
        raise ValueError("Transmitter metadata count does not match RSS tensor")
    total = np.sum(rss, axis=0)
    # Match the stable first-index tie-break used by RSS association. Taking
    # the final two rows from argpartition is not ordered: the former code
    # could occasionally select the second-strongest TX as the baseline server.
    best_idx = np.argmax(rss, axis=0).astype(np.int32)
    best_w = np.take_along_axis(rss, best_idx[None, :], axis=0)[0]
    if n_tx > 1:
        second_candidates = rss.copy()
        second_candidates[best_idx, np.arange(n_cells)] = 0.0
        second_idx = np.argmax(second_candidates, axis=0).astype(np.int32)
        second_w = np.take_along_axis(second_candidates, second_idx[None, :], axis=0)[0]
    else:
        second_idx = np.full(n_cells, -1, dtype=np.int32)
        second_w = np.zeros(n_cells, dtype=np.float64)
    reachable_base = best_w > 0.0
    noise = max(float(noise_power_w), 0.0)
    base_interference = np.maximum(total - best_w, 0.0)
    base_sinr = best_w / np.maximum(noise + base_interference, 1e-300)
    base_sinr_db = linear_to_db(base_sinr)
    base_rss_dbm = watts_to_dbm(best_w)
    baseline_rss_coverage = float(100.0 * np.mean(reachable_base & (base_rss_dbm >= rss_threshold_dbm)))
    baseline_sinr_coverage = float(100.0 * np.mean(reachable_base & (base_sinr_db >= sinr_threshold_db)))

    results: list[dict[str, Any]] = []
    for tx_index in range(n_tx):
        removed_w = rss[tx_index]
        was_best = best_idx == tx_index
        selected_w = np.where(was_best, second_w, best_w)
        selected_idx = np.where(was_best, second_idx, best_idx)
        remaining_total = np.maximum(total - removed_w, 0.0)
        interference = np.maximum(remaining_total - selected_w, 0.0)
        sinr_linear = selected_w / np.maximum(noise + interference, 1e-300)
        sinr_db = linear_to_db(sinr_linear)
        rss_dbm = watts_to_dbm(selected_w)
        reachable = selected_w > 0.0
        rss_covered = reachable & (rss_dbm >= rss_threshold_dbm)
        sinr_covered = reachable & (sinr_db >= sinr_threshold_db)
        comparable = reachable_base & reachable
        delta = sinr_db[comparable] - base_sinr_db[comparable]
        results.append({
            "txIndex": int(tx_index),
            "txId": tx_metadata[tx_index].get("id", f"tx_{tx_index}"),
            "txName": tx_metadata[tx_index].get("name", f"TX {tx_index + 1}"),
            "cellsRemovedWasServing": int(np.sum(was_best & reachable_base)),
            "cellsWithAlternateServer": int(np.sum(was_best & (selected_idx >= 0) & reachable)),
            "rssCoveragePercent": float(100.0 * np.mean(rss_covered)),
            "rssCoverageDeltaPp": float(100.0 * np.mean(rss_covered) - baseline_rss_coverage),
            "sinrCoveragePercent": float(100.0 * np.mean(sinr_covered)),
            "sinrCoverageDeltaPp": float(100.0 * np.mean(sinr_covered) - baseline_sinr_coverage),
            "meanSinrDb": float(np.mean(sinr_db[np.isfinite(sinr_db)])) if np.isfinite(sinr_db).any() else None,
            "meanSinrDeltaDb": float(np.mean(delta)) if delta.size else None,
            "outagePercent": float(100.0 - 100.0 * np.mean(sinr_covered)),
            "servedAreaKm2": float(np.sum(sinr_covered) * float(cell_area_m2) / 1e6),
        })
    return results


def compute_dominant_interferer_matrix(
    rss_w: np.ndarray,
    tx_metadata: list[dict[str, Any]],
    best_rss_tx: np.ndarray | None = None,
    noise_power_w: float = 0.0,
    top_k: int = 3,
) -> dict[str, Any]:
    """Summarize the top-K interferers within each RSS-serving sector's area.

    Each map cell is assigned to its strongest-RSS serving TX; the next K
    strongest TXs are counted as its dominant interferers. This is a compact,
    exact top-K ranking, not an all-pairs sum of weaker interferers.
    """
    rss = _positive_finite(rss_w)
    if rss.ndim != 2:
        raise ValueError("RSS must be [num_tx, num_cells]")
    n_tx, n_cells = rss.shape
    if n_tx != len(tx_metadata):
        raise ValueError("Transmitter metadata count does not match RSS tensor")
    cell_ids = np.arange(n_cells)
    best_idx = np.asarray(best_rss_tx, dtype=np.int32) if best_rss_tx is not None else np.argmax(rss, axis=0).astype(np.int32)
    valid_index = (best_idx >= 0) & (best_idx < n_tx)
    if n_tx < 2:
        valid = valid_index & (rss[np.where(valid_index, best_idx, 0), cell_ids] > 0.0)
        serving_counts = np.bincount(best_idx[valid], minlength=n_tx).astype(int)
        return {"topK": 0, "sectorCount": n_tx, "servingCellCounts": serving_counts.tolist(), "pairs": [], "siteRelationCounts": {"intra_site": 0, "inter_site": 0, "unknown_site": 0}}
    safe_best_idx = np.where(valid_index, best_idx, 0)
    best_w = rss[safe_best_idx, cell_ids]
    valid_victim = valid_index & (best_w > 0.0)
    total = np.sum(rss, axis=0)
    total_interference = np.maximum(total - best_w, 0.0)
    # Reuse one copy and successively zero each selected strongest competitor.
    work = rss.copy()
    work[safe_best_idx[valid_victim], cell_ids[valid_victim]] = 0.0
    counts = np.zeros((n_tx, n_tx), dtype=np.int64)
    sum_top_power = np.zeros((n_tx, n_tx), dtype=np.float64)
    sum_share = np.zeros((n_tx, n_tx), dtype=np.float64)
    sum_sinr_gain = np.zeros((n_tx, n_tx), dtype=np.float64)
    kmax = max(1, min(int(top_k), n_tx - 1))
    for _ in range(kmax):
        candidate_idx = np.argmax(work, axis=0).astype(np.int32)
        candidate_w = work[candidate_idx, cell_ids]
        valid = valid_victim & (candidate_w > 0.0) & (candidate_idx != best_idx)
        if np.any(valid):
            pair_ids = best_idx[valid] * n_tx + candidate_idx[valid]
            counts += np.bincount(pair_ids, minlength=n_tx * n_tx).reshape(n_tx, n_tx)
            sum_top_power += np.bincount(pair_ids, weights=candidate_w[valid], minlength=n_tx * n_tx).reshape(n_tx, n_tx)
            shares = candidate_w[valid] / np.maximum(total_interference[valid], 1e-300)
            sum_share += np.bincount(pair_ids, weights=shares, minlength=n_tx * n_tx).reshape(n_tx, n_tx)
            before = best_w[valid] / np.maximum(float(noise_power_w) + total_interference[valid], 1e-300)
            after = best_w[valid] / np.maximum(float(noise_power_w) + total_interference[valid] - candidate_w[valid], 1e-300)
            gain_db = linear_to_db(after) - linear_to_db(before)
            sum_sinr_gain += np.bincount(pair_ids, weights=gain_db, minlength=n_tx * n_tx).reshape(n_tx, n_tx)
        work[candidate_idx, cell_ids] = 0.0

    serving_counts = np.bincount(best_idx[valid_victim], minlength=n_tx).astype(int)
    pairs: list[dict[str, Any]] = []
    relation_counts = {"intra_site": 0, "inter_site": 0, "unknown_site": 0}
    for victim in range(n_tx):
        for interferer in range(n_tx):
            count = int(counts[victim, interferer])
            if victim == interferer or count == 0:
                continue
            victim_site = tx_metadata[victim].get("site")
            interferer_site = tx_metadata[interferer].get("site")
            if victim_site and interferer_site:
                relation = "intra_site" if str(victim_site) == str(interferer_site) else "inter_site"
            else:
                relation = "unknown_site"
            relation_counts[relation] += count
            pairs.append({
                "victimTxIndex": victim,
                "victimTxId": tx_metadata[victim].get("id", f"tx_{victim}"),
                "victimTxName": tx_metadata[victim].get("name", f"TX {victim + 1}"),
                "victimSite": str(victim_site) if victim_site is not None else None,
                "interfererTxIndex": interferer,
                "interfererTxId": tx_metadata[interferer].get("id", f"tx_{interferer}"),
                "interfererTxName": tx_metadata[interferer].get("name", f"TX {interferer + 1}"),
                "interfererSite": str(interferer_site) if interferer_site is not None else None,
                "siteRelation": relation,
                "cells": count,
                "victimServingCells": int(serving_counts[victim]),
                "shareOfVictimCellsPercent": float(100.0 * count / max(int(serving_counts[victim]), 1)),
                "meanDominantInterferenceDbm": float(watts_to_dbm(np.array([sum_top_power[victim, interferer] / count]))[0]),
                "meanInterferenceSharePercent": float(100.0 * sum_share[victim, interferer] / count),
                "meanSinrGainIfRemovedDb": float(sum_sinr_gain[victim, interferer] / count),
                "rankScope": f"top-{kmax}",
            })
    pairs.sort(key=lambda item: (item["victimTxIndex"], -item["cells"]))
    return {
        "topK": kmax,
        "sectorCount": n_tx,
        "servingCellCounts": serving_counts.tolist(),
        "pairs": pairs,
        "siteRelationCounts": relation_counts,
        "definition": "For cells served by each victim TX, count the strongest K non-serving TXs by received power. Site relation is inferred only when both TXs carry Site metadata. Weaker contributors remain included in the SINR denominator but are not listed in this ranked matrix.",
    }


def compute_sector_analysis(
    path_gain_w: np.ndarray,
    rss_w: np.ndarray,
    sinr_linear: np.ndarray,
    centers: np.ndarray,
    tx_metadata: dict[str, Any],
    tx_index: int,
    noise_power_w: float,
    cell_area_m2: float,
    best_rss_tx: np.ndarray,
    best_sinr_tx: np.ndarray | None = None,
    best_path_gain_tx: np.ndarray | None = None,
) -> dict[str, Any]:
    """Build the on-demand Sector Inspector payload for one TX."""
    rss_all = _positive_finite(rss_w)
    pg_all = _positive_finite(path_gain_w)
    sinr_all = _positive_finite(sinr_linear)
    if not (0 <= int(tx_index) < rss_all.shape[0]):
        raise ValueError(f"Invalid transmitter index {tx_index}")
    idx = int(tx_index)
    n_tx, n_cells = rss_all.shape
    rss = rss_all[idx]
    tx_rss_dbm = watts_to_dbm(rss)
    pg_db = linear_to_db(pg_all[idx])
    native_sinr_db = linear_to_db(sinr_all[idx])
    total = np.sum(rss_all, axis=0)
    interference = np.maximum(total - rss, 0.0)
    noise = max(float(noise_power_w), 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        snr_linear = rss / max(noise, 1e-300)
        sir_linear = rss / np.maximum(interference, 1e-300)
        inr_linear = interference / max(noise, 1e-300)
    snr_db = linear_to_db(snr_linear)
    sir_db = linear_to_db(sir_linear)
    inr_db = linear_to_db(inr_linear)
    interference_dbm = watts_to_dbm(interference)
    no_interference = interference <= 0.0
    interference_dbm[no_interference] = ZERO_POWER_DBM_FLOOR
    sir_db[no_interference & (rss > 0.0)] = NO_INTERFERENCE_RATIO_CEILING_DB
    sir_db[no_interference & (rss <= 0.0)] = np.nan
    inr_db[no_interference] = ZERO_POWER_DBM_FLOOR
    area = float(cell_area_m2)
    summaries = {
        "rss": {**_summary(tx_rss_dbm, -100.0, area), "metric": "power", "unit": "dBm"},
        "pathGain": {**_summary(pg_db, -110.0, area), "metric": "path_gain", "unit": "dB"},
        "sinr": {**_summary(native_sinr_db, 0.0, area), "metric": "sinr", "unit": "dB"},
        "snr": {**_summary(snr_db, 0.0, area), "metric": "snr", "unit": "dB"},
        "interference": {**_summary(interference_dbm, -100.0, area, lower_is_better=True), "metric": "interference", "unit": "dBm"},
        "sir": {**_summary(sir_db, 0.0, area), "metric": "sir", "unit": "dB"},
        "inr": {**_summary(inr_db, -10.0, area, lower_is_better=True), "metric": "inr", "unit": "dB"},
    }
    serving = np.asarray(best_rss_tx, dtype=np.int32)
    counts = {
        "rss": int(np.sum(serving == idx)),
        "sinr": int(np.sum(np.asarray(best_sinr_tx) == idx)) if best_sinr_tx is not None else 0,
        "pathGain": int(np.sum(np.asarray(best_path_gain_tx) == idx)) if best_path_gain_tx is not None else 0,
    }
    radial_profile: list[dict[str, Any]] = []
    position = tx_metadata.get("positionEnuM") or tx_metadata.get("position_enu_m")
    if isinstance(position, (list, tuple)) and len(position) >= 2 and len(centers) == n_cells:
        distance = np.sqrt((np.asarray(centers)[:, 0] - float(position[0])) ** 2 + (np.asarray(centers)[:, 1] - float(position[1])) ** 2)
        finite_distance = distance[np.isfinite(distance)]
        max_distance = float(np.max(finite_distance)) if finite_distance.size else 0.0
        edges = np.linspace(0.0, max(max_distance, 1.0), 9)
        for bin_index in range(len(edges) - 1):
            mask = (distance >= edges[bin_index]) & (distance < edges[bin_index + 1] if bin_index < len(edges) - 2 else distance <= edges[bin_index + 1])
            if not np.any(mask):
                continue
            rss_finite = tx_rss_dbm[mask & np.isfinite(tx_rss_dbm)]
            sinr_finite = native_sinr_db[mask & np.isfinite(native_sinr_db)]
            radial_profile.append({
                "distanceStartM": float(edges[bin_index]),
                "distanceEndM": float(edges[bin_index + 1]),
                "cellCount": int(np.sum(mask)),
                "meanRssDbm": float(np.mean(rss_finite)) if rss_finite.size else None,
                "meanSinrDb": float(np.mean(sinr_finite)) if sinr_finite.size else None,
            })
    return {
        "txIndex": idx,
        "transmitter": tx_metadata,
        "associations": counts,
        "associationSharePercent": {k: float(100.0 * v / max(n_cells, 1)) for k, v in counts.items()},
        "noisePowerDbm": float(watts_to_dbm(np.array([noise]))[0]) if noise > 0 else None,
        "summaries": summaries,
        "radialProfile": radial_profile,
        "interpretation": {
            "sinr": "Native Sionna per-TX SINR in the presence of all other transmitters in this radio-map solve.",
            "snr": "Derived isolated-sector SNR = this TX RSS / thermal noise; all other TX contributions are excluded.",
            "interference": "Sum of the RSS powers of all other TXs in the same simulated co-channel scene.",
        },
    }


def sample_sector_cells(
    centers: np.ndarray,
    rss_w: np.ndarray,
    sinr_linear: np.ndarray,
    tx_index: int,
    noise_power_w: float,
    criterion: str = "weak_sinr",
    limit: int = 200,
    association_scope: str = "all",
    selection_mode: str = "spatially_distributed",
) -> list[dict[str, Any]]:
    """Select deterministic radio-map cells for export / follow-up PathSolver runs.

    ``association_scope`` may restrict candidates to the chosen sector's RSS
    serving footprint or best-SINR footprint. ``strict_topk`` returns the true
    weakest/strongest K rows; ``spatially_distributed`` preserves the legacy
    evenly-spaced sampling over the complete ranked list.
    """
    rss_all = _positive_finite(rss_w)
    sinr_all = _positive_finite(sinr_linear)
    idx = int(tx_index)
    if not 0 <= idx < rss_all.shape[0]:
        raise ValueError(f"Invalid transmitter index {tx_index}")
    if association_scope not in {"all", "rss_serving", "sinr_serving"}:
        raise ValueError("association_scope must be all, rss_serving, or sinr_serving")
    if selection_mode not in {"strict_topk", "spatially_distributed"}:
        raise ValueError("selection_mode must be strict_topk or spatially_distributed")
    limit = max(1, min(int(limit), 2000))
    rss = rss_all[idx]
    total = np.sum(rss_all, axis=0)
    interference = np.maximum(total - rss, 0.0)
    if criterion == "weak_sinr":
        values = linear_to_db(sinr_all[idx])
        order = np.argsort(np.where(np.isfinite(values), values, np.inf))
    elif criterion == "weak_rss":
        values = watts_to_dbm(rss)
        order = np.argsort(np.where(np.isfinite(values), values, np.inf))
    elif criterion == "strong_interference":
        values = watts_to_dbm(interference)
        order = np.argsort(np.where(np.isfinite(values), values, -np.inf))[::-1]
    else:
        raise ValueError("criterion must be weak_sinr, weak_rss, or strong_interference")
    finite_mask = np.isfinite(values)
    # Footprint membership is based on the corresponding native per-TX layer.
    # Zero/invalid values are not treated as a serving association.
    if association_scope == "rss_serving":
        maxima = np.max(rss_all, axis=0)
        serving = np.argmax(rss_all, axis=0)
        finite_mask &= (serving == idx) & (maxima > 0.0)
    elif association_scope == "sinr_serving":
        maxima = np.max(sinr_all, axis=0)
        serving = np.argmax(sinr_all, axis=0)
        finite_mask &= (serving == idx) & (maxima > 0.0)
    order = order[finite_mask[order]]
    if order.size == 0:
        return []
    # Legacy spatial distribution avoids returning only adjacent cells from a
    # contiguous weak patch. Strict Top-K is available when the actual worst
    # locations are the research target.
    if selection_mode == "spatially_distributed" and order.size > limit:
        positions = np.linspace(0, order.size - 1, limit, dtype=np.int64)
        order = order[positions]
    else:
        order = order[:limit]
    result: list[dict[str, Any]] = []
    c = np.asarray(centers, dtype=np.float64)
    for cell_idx in order:
        rssi = float(rss[cell_idx])
        inter = float(interference[cell_idx])
        sinr_value = float(sinr_all[idx, cell_idx])
        result.append({
            "cellIndex": int(cell_idx),
            "x": float(c[cell_idx, 0]), "y": float(c[cell_idx, 1]), "z": float(c[cell_idx, 2]),
            "rssDbm": float(watts_to_dbm(np.array([rssi]))[0]) if rssi > 0 else None,
            "sinrDb": float(linear_to_db(np.array([sinr_value]))[0]) if sinr_value > 0 else None,
            "interferenceDbm": float(watts_to_dbm(np.array([inter]))[0]) if inter > 0 else ZERO_POWER_DBM_FLOOR,
            "snrDb": float(linear_to_db(np.array([rssi / max(float(noise_power_w), 1e-300)]))[0]) if rssi > 0 else None,
            "associationScope": association_scope,
            "selectionMode": selection_mode,
        })
    return result

def radio_map_cell_value(metric: str, row: dict[str, Any]) -> float:
    """Metric value stored in RadioMapCell.metricValue."""
    field = {
        "power": "powerDbm",
        "path_gain": "pathGainDb",
        "path_loss": "effectivePathLossDb",
        "sinr": "sinr",
        "best_sinr": "bestSinrDb",
        "interference": "interferencePowerDbm",
        "sir": "sirDb",
        "inr": "inrDb",
        "dominance": "dominanceMarginDb",
    }[metric]
    value = row.get(field)
    return float(value) if value is not None else float("nan")
