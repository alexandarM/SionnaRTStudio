import numpy as np
import pytest

from backend.solver import _RADIO_MAP_CACHE, _RADIO_MAP_CACHE_BYTES, _cache_radio_map, get_radio_map_tx_data


def test_bounded_cache_returns_one_transmitter_grid():
    centers = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.float64)
    pg = np.array([[1e-8, 2e-8], [3e-8, 4e-8]], dtype=np.float64)
    rss = pg * 1e-3
    sinr = np.array([[10, 5], [3, 2]], dtype=np.float64)
    meta = [
        {"id": "tx-a", "name": "A", "site": "S1", "frequencyBand": "n78"},
        {"id": "tx-b", "name": "B", "site": "S2", "frequencyBand": "n78"},
    ]
    key = _cache_radio_map(
        centers, pg, rss, sinr, meta, 8.0,
        best_rss_tx=np.array([0, 1]),
        best_sinr_tx=np.array([1, 0]),
        best_path_gain_tx=np.array([1, 1]),
    )
    assert key is not None
    out = get_radio_map_tx_data(key, 1)
    assert out["metadata"]["id"] == "tx-b"
    assert out["centers"].dtype == np.float32
    assert out["pathGain"].dtype == np.float32
    assert np.allclose(out["pathGain"], pg[1])
    assert np.allclose(out["rss"], rss[1])
    assert out["bestRssTx"].tolist() == [0, 1]
    assert out["bestSinrTx"].tolist() == [1, 0]
    assert out["bestPathGainTx"].tolist() == [1, 1]
    with pytest.raises(ValueError, match="Invalid transmitter index"):
        get_radio_map_tx_data(key, 3)


def test_expired_map_id_returns_actionable_error():
    with pytest.raises(ValueError, match="no longer in the backend cache"):
        get_radio_map_tx_data("definitely-expired-map", 0)


def test_sector_inspector_interference_matrix_and_sampling_use_bounded_cache():
    from backend.solver import (
        get_radio_map_interference_matrix,
        get_radio_map_sample_cells,
        get_radio_map_sector_analysis,
    )

    centers = np.array([[0, 0, 1.5], [10, 0, 1.5], [20, 0, 1.5]], dtype=np.float32)
    path_gain = np.array([[1e-8, 2e-8, 3e-8], [1e-9, 1e-9, 1e-9]], dtype=np.float32)
    rss = np.array([[1e-6, 2e-6, 3e-6], [2e-7, 1e-7, 1e-7]], dtype=np.float32)
    sinr = np.array([[5.0, 10.0, 15.0], [0.2, 0.1, 0.1]], dtype=np.float32)
    metadata = [
        {"id": "tx-a", "name": "A", "site": "SITE-1", "positionEnuM": [0, 0, 20]},
        {"id": "tx-b", "name": "B", "site": "SITE-2", "positionEnuM": [100, 0, 20]},
    ]
    key = _cache_radio_map(
        centers, path_gain, rss, sinr, metadata, 10.0,
        noise_power_dbm=-100.0,
        best_rss_tx=np.array([0, 0, 0]),
        best_sinr_tx=np.array([0, 0, 0]),
        best_path_gain_tx=np.array([0, 0, 0]),
    )
    assert key is not None
    try:
        report = get_radio_map_sector_analysis(key, 0)
        assert report["txIndex"] == 0
        assert report["summaries"]["snr"]["mean"] > report["summaries"]["sinr"]["mean"]
        matrix = get_radio_map_interference_matrix(key, top_k=1)
        assert matrix["pairs"][0]["siteRelation"] == "inter_site"
        samples = get_radio_map_sample_cells(key, 0, criterion="weak_sinr", limit=2)
        assert len(samples) == 2
        assert all("x" in sample and "sinrDb" in sample for sample in samples)
    finally:
        _RADIO_MAP_CACHE.pop(key, None)


def test_scene_context_is_retained_for_channel_analysis():
    context = {"frequencyGhz": 3.5, "maxDepth": 5, "token": "Channel Analysis-context"}
    key = _cache_radio_map(
        np.array([[0.0, 0.0, 1.5]]),
        np.array([[1e-8]]),
        np.array([[1e-9]]),
        np.array([[2.0]]),
        [{"id": "tx", "name": "TX"}],
        5.0,
        scene_context=context,
    )
    assert key is not None
    try:
        from backend.solver import _get_cached_radio_map
        assert _get_cached_radio_map(key)["sceneContext"] == context
    finally:
        _RADIO_MAP_CACHE.pop(key, None)
