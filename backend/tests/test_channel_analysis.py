"""Pure channel-analysis tests; no Sionna runtime/GPU needed."""
import math
import unittest

import numpy as np

from backend.models import ChannelAnalysisRequest, ENUVector, PropagationPath
from backend.solver import (
    _channel_k_factor,
    _channel_profiles_for_pair,
    _estimate_channel_cfr_samples,
    _notebook_tau_shape,
)


def _path(path_id, power_dbm, kind):
    return PropagationPath(
        id=path_id,
        points=[ENUVector(x=0, y=0, z=1), ENUVector(x=1, y=0, z=1)],
        type=kind,
        order=0 if kind == "LOS" else 1,
        distance=1.0,
        pathLossDb=0.0,
        receivedPowerDbm=power_dbm,
        delayNs=10.0,
    )


class TestChannelAnalysisRequest(unittest.TestCase):
    def test_requires_cell_indices_and_selected_tx(self):
        with self.assertRaises(Exception):
            ChannelAnalysisRequest(cellIndices=[])
        with self.assertRaisesRegex(Exception, "txIndex is required"):
            ChannelAnalysisRequest(cellIndices=[0], txMode="selected")

    def test_rejects_duplicate_cells_and_invalid_rx_array(self):
        with self.assertRaisesRegex(Exception, "duplicates"):
            ChannelAnalysisRequest(cellIndices=[2, 2])
        with self.assertRaises(Exception):
            ChannelAnalysisRequest(cellIndices=[0], rxArraySize=(0, 1))

    def test_valid_selection(self):
        req = ChannelAnalysisRequest(
            cellIndices=[0, 4, 9], txMode="selected", txIndex=2,
            rxArraySize=(2, 1), numSubcarriers=128,
        )
        self.assertEqual(req.cellIndices, [0, 4, 9])
        self.assertEqual(req.rxArraySize, (2, 1))


class TestChannelAnalysisResourceBudget(unittest.TestCase):
    def test_cfr_sample_estimate_includes_all_devices_ports_and_subcarriers(self):
        self.assertEqual(_estimate_channel_cfr_samples(24, 4, 64, 128), 786432)


class TestKFactor(unittest.TestCase):
    def test_los_to_nlos_power_ratio(self):
        value, note = _channel_k_factor([
            _path("los", -60.0, "LOS"),
            _path("nlos1", -70.0, "Reflection"),
            _path("nlos2", -70.0, "NLOS"),
        ])
        # Two -70 dBm scattered paths sum to -66.99 dBm; K is 6.99 dB.
        self.assertAlmostEqual(value, 6.9897, places=3)
        self.assertIsNone(note)

    def test_nlos_only_has_no_k_factor(self):
        value, note = _channel_k_factor([_path("r", -80.0, "Reflection")])
        self.assertIsNone(value)
        self.assertIn("No valid LOS", note)

    def test_los_only_is_not_reported_as_finite_k(self):
        value, note = _channel_k_factor([_path("l", -80.0, "LOS")])
        self.assertIsNone(value)
        self.assertIn("+infinity", note)


class TestNativeChannelProfileReduction(unittest.TestCase):
    def _fixture(self, rx_ant=1):
        n_rx, n_tx, n_tx_ant, n_path, n_time, n_sc = 2, 2, 2, 3, 1, 8
        a = np.zeros((n_rx, rx_ant, n_tx, n_tx_ant, n_path, n_time), dtype=np.complex128)
        a[1, 0, 1, 0, 0, 0] = 1.0 + 1.0j
        a[1, 0, 1, 1, 0, 0] = 1.0 + 1.0j
        a[1, 0, 1, 0, 1, 0] = 0.5 + 0j
        tau = np.zeros((n_rx, n_tx, n_path), dtype=float)
        tau[1, 1] = [10e-9, 20e-9, 30e-9]
        h = np.zeros((n_rx, rx_ant, n_tx, n_tx_ant, n_time, n_sc), dtype=np.complex128)
        h[1, :, 1, 0, 0, :] = 1.0 + 0j
        h[1, :, 1, 1, 0, :] = 1.0 + 0j
        frequencies = np.linspace(-105e3, 105e3, n_sc)
        valid = np.zeros((n_rx, n_tx, n_path), dtype=bool)
        valid[1, 1] = [True, True, False]
        return a, tau, h, frequencies, valid

    def test_siso_cir_and_cfr_preserve_native_timing_and_phase(self):
        a, tau, h, frequencies, valid = self._fixture(rx_ant=1)
        taps, cfr = _channel_profiles_for_pair(
            a, tau, h, frequencies, valid, 1, 1, 30.0, 1, 2, 10,
        )
        self.assertEqual(len(taps), 2)
        self.assertAlmostEqual(taps[0]["delayNs"], 10.0)
        self.assertAlmostEqual(taps[0]["receivedPowerDbm"], 30.0 + 10.0 * math.log10(4.0))
        self.assertTrue(cfr["phaseAvailable"])
        self.assertEqual(len(cfr["phaseDeg"]), len(frequencies))
        self.assertAlmostEqual(cfr["magnitudeDb"][0], 10.0 * math.log10(2.0))

    def test_antenna_expanded_tau_shape_is_preserved(self):
        a, tau, _h, _frequencies, _valid = self._fixture(rx_ant=2)
        expanded = np.broadcast_to(
            tau[:, None, :, None, :],
            (a.shape[0], a.shape[1], a.shape[2], a.shape[3], a.shape[4]),
        ).copy()
        result = _notebook_tau_shape(a, expanded)
        self.assertEqual(result.shape, expanded.shape)
        self.assertTrue(np.array_equal(result, expanded))

    def test_multi_rx_port_cfr_does_not_invent_scalar_phase(self):
        a, tau, h, frequencies, valid = self._fixture(rx_ant=2)
        taps, cfr = _channel_profiles_for_pair(
            a, tau, h, frequencies, valid, 1, 1, 30.0, 2, 2, 10,
        )
        self.assertEqual(len(taps), 2)
        self.assertFalse(cfr["phaseAvailable"])
        self.assertIsNone(cfr["phaseDeg"])
        self.assertIn("unique scalar phase", cfr["phaseNote"])


if __name__ == "__main__":
    unittest.main()
