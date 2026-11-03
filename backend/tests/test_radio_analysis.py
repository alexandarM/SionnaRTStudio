import math
import numpy as np
import pytest

from backend.radio_analysis import compute_radio_map_analytics


def test_radio_map_analytics_uses_native_linear_power_and_correct_interference():
    path_gain = np.array([[1e-7, 1e-8], [1e-8, 1e-7]], dtype=float)
    rss = np.array([[1e-3, 1e-4], [1e-4, 1e-3]], dtype=float)
    # 10x or 0.1x linear SINR as a controlled test input.
    sinr = np.array([[10.0, 0.1], [0.1, 10.0]], dtype=float)
    tx = [
        {"id": "a", "name": "Sector A", "site": "S1", "frequencyBand": "n78", "powerDbm": 30.0},
        {"id": "b", "name": "Sector B", "site": "S1", "frequencyBand": "n78", "powerDbm": 30.0},
    ]
    result = compute_radio_map_analytics(
        path_gain, rss, sinr, tx, bandwidth_hz=20e6,
        temperature_k=293.0 * 10 ** (7 / 10), cell_area_m2=64.0,
        metric="sir", threshold=0.0,
    )
    assert result["bestRssTx"].tolist() == [0, 1]
    assert np.allclose(result["sirDb"], [10.0, 10.0], atol=1e-6)
    assert np.allclose(result["dominanceMarginDb"], [10.0, 10.0], atol=1e-6)
    assert result["stats"]["servedPercent"] == 100.0
    assert result["stats"]["servedAreaKm2"] == 2 * 64 / 1e6
    assert result["txStats"][0]["servingCellCount"] == 1
    assert result["txStats"][1]["servingCellCount"] == 1
    assert result["txStats"][0]["site"] == "S1"


def test_single_transmitter_has_no_interference_or_competing_sector():
    result = compute_radio_map_analytics(
        np.array([[1e-8, 1e-9]]),
        np.array([[1e-6, 1e-7]]),
        np.array([[100.0, 10.0]]),
        [{"id": "a", "name": "Only sector", "powerDbm": 20.0}],
        bandwidth_hz=10e6, temperature_k=293.0, cell_area_m2=25.0,
        metric="power", threshold=-90.0,
    )
    assert result["bestRssTx"].tolist() == [0, 0]
    assert np.all(result["dominanceMarginDb"] == 300.0)  # no competing sector: display ceiling
    assert np.all(result["sirDb"] == 300.0)  # finite display ceiling for no interference
    assert np.all(result["interferenceDbm"] == -300.0)  # finite zero-power floor
    assert result["stats"]["count"] == 2
    assert result["stats"]["servedPercent"] == 100.0


def test_coverage_probability_denominator_is_full_grid_including_unreachable_cells():
    # One of four cells has no received power (0 W -> -inf RSS).
    result = compute_radio_map_analytics(
        np.array([[1e-8, 1e-8, 0.0, 1e-8]]),
        np.array([[1e-6, 1e-7, 0.0, 1e-8]]),
        np.array([[10.0, 1.0, 0.0, 0.1]]),
        [{"id": "a", "name": "A", "powerDbm": 30.0}],
        bandwidth_hz=20e6, temperature_k=293.0, cell_area_m2=100.0,
        metric="power", threshold=-35.0,
    )
    stats = result["stats"]
    assert stats["count"] == 4
    assert stats["reachableCount"] == 3
    assert stats["reachablePercent"] == 75.0
    assert stats["servedPercent"] == 25.0
    assert stats["servedAreaKm2"] == 100 / 1e6
    assert stats["totalAreaKm2"] == 400 / 1e6


def test_invalid_metric_and_mismatched_shapes_are_rejected():
    tx = [{"id": "a", "name": "A"}]
    try:
        compute_radio_map_analytics(np.ones((1, 2)), np.ones((1, 2)), np.ones((1, 2)), tx,
                                    1e6, 293, 1, metric="rsrp")
        assert False, "Expected unsupported metric error"
    except ValueError as exc:
        assert "Unsupported" in str(exc)
    try:
        compute_radio_map_analytics(np.ones((1, 2)), np.ones((1, 3)), np.ones((1, 2)), tx,
                                    1e6, 293, 1)
        assert False, "Expected shape error"
    except ValueError as exc:
        assert "matching shapes" in str(exc)


def test_path_gain_and_best_sinr_associations_are_independent_of_rss_serving_tx():
    # TX 0 has greater conducted power and therefore greater RSS, while TX 1
    # has better path gain and SINR. The associations must not be conflated.
    result = compute_radio_map_analytics(
        path_gain_w=np.array([[1e-8], [1e-6]]),
        rss_w=np.array([[1e-3], [1e-4]]),
        sinr_linear=np.array([[2.0], [20.0]]),
        tx_metadata=[
            {"id": "tx0", "name": "High-power TX", "site": "S-A"},
            {"id": "tx1", "name": "High-gain TX", "site": "S-B"},
        ],
        bandwidth_hz=20e6, temperature_k=293.0, cell_area_m2=100.0,
        metric="best_sinr",
    )
    assert result["bestRssTx"].tolist() == [0]
    assert result["bestPathGainTx"].tolist() == [1]
    assert result["bestSinrTx"].tolist() == [1]
    assert result["metricValues"][0] == pytest.approx(10 * np.log10(20.0))
    assert [x["site"] for x in result["siteStats"]] == ["S-A", "S-B"]


def test_mean_rss_is_linear_power_average_before_conversion_to_dbm():
    result = compute_radio_map_analytics(
        path_gain_w=np.array([[1e-8, 1e-8]]),
        rss_w=np.array([[1e-3, 1e-4]]),
        sinr_linear=np.array([[10.0, 1.0]]),
        tx_metadata=[{"id": "tx0", "name": "TX", "site": "S1"}],
        bandwidth_hz=20e6, temperature_k=293.0, cell_area_m2=100.0,
        metric="power",
    )
    expected = 10 * np.log10((1e-3 + 1e-4) / 2) + 30
    assert result["stats"]["meanRssDbm"] == pytest.approx(expected)
    assert result["siteStats"][0]["meanRssDbm"] == pytest.approx(expected)


def test_lower_is_better_coverage_metrics_use_at_or_below_threshold():
    from backend.radio_analysis import _summary
    values = np.array([90.0, 105.0, 120.0, np.nan])
    result = _summary(values, threshold=110.0, cell_area_m2=100.0, lower_is_better=True)
    assert result["thresholdComparison"] == "at_or_below"
    assert result["servedPercent"] == 50.0
    assert result["outagePercent"] == 50.0


def test_zero_signal_cell_does_not_get_infinite_sir():
    result = compute_radio_map_analytics(
        np.array([[1e-8, 0.0]]),
        np.array([[1e-6, 0.0]]),
        np.array([[10.0, 0.0]]),
        [{"id": "tx0", "name": "TX"}],
        bandwidth_hz=20e6, temperature_k=293.0, cell_area_m2=100.0,
        metric="sir",
    )
    assert result["sirDb"][0] == 300.0
    assert np.isnan(result["sirDb"][1])
    assert result["interferenceDbm"][1] == -300.0


def test_analytics_payload_matches_coverage_stats_api_model():
    from backend.models import CoverageStats

    result = compute_radio_map_analytics(
        np.array([[1e-8, 1e-9], [1e-9, 1e-8]]),
        np.array([[1e-6, 1e-7], [1e-7, 1e-6]]),
        np.array([[10.0, 1.0], [1.0, 10.0]]),
        [
            {"id": "a", "name": "A", "site": "S1"},
            {"id": "b", "name": "B", "site": "S1"},
        ],
        bandwidth_hz=20e6, temperature_k=293.0, cell_area_m2=64.0,
        metric="best_sinr",
    )
    stats = CoverageStats(**result["stats"])
    assert stats.metric == "best_sinr"
    assert stats.thresholdComparison == "at_or_above"
    assert len(stats.histogram) == 20
    assert len(stats.cdf) == 21


def test_effective_noise_temperature_matches_sionna_scene_setting():
    """The post-processing path must use the Python scalar assigned to Sionna.

    Sionna may expose ``scene.temperature`` as a Dr.Jit array afterwards;
    callers must not convert that property directly with ``float()``.
    """
    noise_figure_db = 7.0
    expected_temperature_k = 293.0 * (10.0 ** (noise_figure_db / 10.0))

    # This is the scalar assigned to scene.temperature and passed to analytics.
    # It must remain an ordinary Python float, not be read back from the
    # Dr.Jit-backed scene property.
    noise_temperature_k = 293.0 * (10.0 ** (float(noise_figure_db) / 10.0))
    assert isinstance(noise_temperature_k, float)
    assert noise_temperature_k == pytest.approx(expected_temperature_k)


def test_associations_use_negative_one_for_cells_without_a_finite_signal():
    result = compute_radio_map_analytics(
        path_gain_w=np.array([[1e-8, 0.0], [0.0, 0.0]]),
        rss_w=np.array([[1e-6, 0.0], [1e-7, 0.0]]),
        sinr_linear=np.array([[10.0, 0.0], [0.0, 0.0]]),
        tx_metadata=[{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
        bandwidth_hz=20e6, temperature_k=293.0, cell_area_m2=25.0,
    )
    assert result["bestRssTx"].tolist() == [0, -1]
    assert result["bestSinrTx"].tolist() == [0, -1]
    assert result["bestPathGainTx"].tolist() == [0, -1]
    assert result["topInterfererTx"].tolist() == [1, -1]


def test_leave_one_out_removes_server_and_reassigns_cells_without_reraytracing():
    from backend.radio_analysis import compute_leave_one_out_analytics

    rss = np.array([[10.0, 8.0, 1.0], [4.0, 2.0, 9.0]])
    rows = compute_leave_one_out_analytics(
        rss, noise_power_w=1.0, cell_area_m2=100.0,
        tx_metadata=[{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
        rss_threshold_dbm=0.0, sinr_threshold_db=0.0,
    )
    assert rows[0]["cellsRemovedWasServing"] == 2
    assert rows[0]["cellsWithAlternateServer"] == 2
    assert rows[0]["rssCoveragePercent"] == pytest.approx(100.0)
    assert rows[1]["cellsRemovedWasServing"] == 1
    assert rows[0]["meanSinrDeltaDb"] is not None


def test_dominant_interferer_matrix_ranks_other_sectors_within_serving_area():
    from backend.radio_analysis import compute_dominant_interferer_matrix

    rss = np.array([
        [10.0, 8.0, 1.0, 0.0],
        [4.0, 2.0, 9.0, 3.0],
        [3.0, 1.0, 4.0, 2.0],
    ])
    best = np.array([0, 0, 1, 1])
    matrix = compute_dominant_interferer_matrix(
        rss, [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}],
        best_rss_tx=best, noise_power_w=1.0, top_k=2,
    )
    pair = next(p for p in matrix["pairs"] if p["victimTxIndex"] == 0 and p["interfererTxIndex"] == 1)
    assert pair["cells"] == 2
    assert pair["shareOfVictimCellsPercent"] == pytest.approx(100.0)
    assert pair["meanInterferenceSharePercent"] > 0.0
    assert pair["meanSinrGainIfRemovedDb"] > 0.0


def test_sector_inspector_reports_isolated_snr_separately_from_network_sinr():
    from backend.radio_analysis import compute_sector_analysis

    report = compute_sector_analysis(
        path_gain_w=np.array([[1e-8, 2e-8], [1e-9, 2e-9]]),
        rss_w=np.array([[1e-6, 2e-6], [1e-7, 1e-7]]),
        sinr_linear=np.array([[10.0, 20.0], [0.1, 0.1]]),
        centers=np.array([[0, 0, 1.5], [100, 0, 1.5]], dtype=float),
        tx_metadata={"id": "a", "name": "Sector A", "positionEnuM": [0, 0, 20]},
        tx_index=0, noise_power_w=1e-8, cell_area_m2=100.0,
        best_rss_tx=np.array([0, 0]), best_sinr_tx=np.array([0, 0]),
        best_path_gain_tx=np.array([0, 0]),
    )
    assert report["associations"]["rss"] == 2
    assert report["summaries"]["snr"]["mean"] > report["summaries"]["sinr"]["mean"]
    assert len(report["radialProfile"]) >= 1
    assert "isolated-sector SNR" in report["interpretation"]["snr"]


def test_sector_cell_sampling_is_deterministic_and_respects_limit():
    from backend.radio_analysis import sample_sector_cells

    rows = sample_sector_cells(
        centers=np.array([[0, 0, 1.5], [1, 0, 1.5], [2, 0, 1.5], [3, 0, 1.5]], dtype=float),
        rss_w=np.array([[1e-6, 2e-6, 3e-6, 4e-6]]),
        sinr_linear=np.array([[4.0, 3.0, 2.0, 1.0]]),
        tx_index=0, noise_power_w=1e-9, criterion="weak_sinr", limit=2,
    )
    assert [row["cellIndex"] for row in rows] == [3, 0]


def test_sector_cell_sampling_supports_true_topk_and_association_footprints():
    from backend.radio_analysis import sample_sector_cells

    centers = np.array([[i, 0, 1.5] for i in range(4)], dtype=float)
    rss = np.array([[10.0, 2.0, 8.0, 1.0], [1.0, 5.0, 2.0, 9.0]])
    sinr = np.array([[1.0, 9.0, 2.0, 1.0], [2.0, 1.0, 3.0, 8.0]])

    strict = sample_sector_cells(
        centers, rss, sinr, tx_index=0, noise_power_w=1e-9,
        criterion="weak_sinr", limit=2, selection_mode="strict_topk",
    )
    assert [row["cellIndex"] for row in strict] == [0, 3]

    rss_footprint = sample_sector_cells(
        centers, rss, sinr, tx_index=0, noise_power_w=1e-9,
        criterion="weak_sinr", limit=10, association_scope="rss_serving",
        selection_mode="strict_topk",
    )
    assert [row["cellIndex"] for row in rss_footprint] == [0, 2]
    assert all(row["associationScope"] == "rss_serving" for row in rss_footprint)

    sinr_footprint = sample_sector_cells(
        centers, rss, sinr, tx_index=0, noise_power_w=1e-9,
        criterion="weak_sinr", limit=10, association_scope="sinr_serving",
        selection_mode="strict_topk",
    )
    assert [row["cellIndex"] for row in sinr_footprint] == [1]


def test_sector_cell_sampling_rejects_unknown_scope_or_selection_mode():
    from backend.radio_analysis import sample_sector_cells

    args = (
        np.array([[0, 0, 1.5]], dtype=float),
        np.array([[1e-6]]),
        np.array([[1.0]]),
        0,
        1e-9,
    )
    with pytest.raises(ValueError, match="association_scope"):
        sample_sector_cells(*args, association_scope="nearest_tx")
    with pytest.raises(ValueError, match="selection_mode"):
        sample_sector_cells(*args, selection_mode="random")


def test_leave_one_out_uses_strongest_tx_as_baseline_and_second_best_after_removal():
    from backend.radio_analysis import compute_leave_one_out_analytics

    # Three unequal TX powers are deliberately chosen because argpartition's
    # final two elements are not guaranteed to be ordered by power.
    rows = compute_leave_one_out_analytics(
        np.array([[100.0], [90.0], [10.0]]), noise_power_w=1.0,
        cell_area_m2=100.0,
        tx_metadata=[{"id": "a"}, {"id": "b"}, {"id": "c"}],
        rss_threshold_dbm=-100.0, sinr_threshold_db=-100.0,
    )
    assert [row["cellsRemovedWasServing"] for row in rows] == [1, 0, 0]
    # Removing the true strongest TX must promote TX 1 (90 W), not TX 2 (10 W).
    assert rows[0]["cellsWithAlternateServer"] == 1
    assert rows[0]["meanSinrDb"] == pytest.approx(10 * np.log10(90.0 / 11.0))


def test_interference_matrix_exposes_intra_and_inter_site_relationships():
    from backend.radio_analysis import compute_dominant_interferer_matrix

    matrix = compute_dominant_interferer_matrix(
        rss_w=np.array([[10.0, 8.0], [5.0, 4.0], [3.0, 2.0]]),
        tx_metadata=[
            {"id": "a", "name": "A", "site": "SITE-1"},
            {"id": "b", "name": "B", "site": "SITE-1"},
            {"id": "c", "name": "C", "site": "SITE-2"},
        ],
        best_rss_tx=np.array([0, 0]), noise_power_w=1.0, top_k=2,
    )
    intra = next(p for p in matrix["pairs"] if p["victimTxIndex"] == 0 and p["interfererTxIndex"] == 1)
    inter = next(p for p in matrix["pairs"] if p["victimTxIndex"] == 0 and p["interfererTxIndex"] == 2)
    assert intra["siteRelation"] == "intra_site"
    assert inter["siteRelation"] == "inter_site"
    assert matrix["siteRelationCounts"]["intra_site"] > 0
    assert matrix["siteRelationCounts"]["inter_site"] > 0


def test_single_sector_interference_matrix_counts_only_reachable_associations():
    from backend.radio_analysis import compute_dominant_interferer_matrix

    matrix = compute_dominant_interferer_matrix(
        rss_w=np.array([[1e-6, 0.0, 2e-6]]),
        tx_metadata=[{"id": "a", "name": "A", "site": "S1"}],
        best_rss_tx=np.array([0, -1, 0]), noise_power_w=1e-9,
    )
    assert matrix["servingCellCounts"] == [2]
    assert matrix["pairs"] == []


def test_extended_per_sector_statistics_validate_against_api_model():
    from backend.models import TransmitterRadioStats

    result = compute_radio_map_analytics(
        path_gain_w=np.array([[1e-8, 2e-8], [2e-9, 1e-9]]),
        rss_w=np.array([[1e-6, 2e-6], [2e-7, 1e-7]]),
        sinr_linear=np.array([[5.0, 10.0], [0.2, 0.1]]),
        tx_metadata=[
            {"id": "a", "name": "A", "site": "S1"},
            {"id": "b", "name": "B", "site": "S2"},
        ],
        bandwidth_hz=20e6, temperature_k=293.0, cell_area_m2=100.0,
    )
    sector = TransmitterRadioStats(**result["txStats"][0])
    assert sector.rssP10Dbm is not None
    assert sector.meanSnrDb is not None
    assert sector.sinrAssociationPercent == 100.0
    assert sector.leaveOneOut is not None
