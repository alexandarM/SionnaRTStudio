"""Pure NumPy tests for the RT CIR -> reciprocal PUSCH channel adapter."""
import unittest

import numpy as np

from backend.linklevel import noise_power_dbm
from backend.linkphy import (
    _absolute_link_budget,
    _prepare_reciprocal_ul_cir,
    _slot_batch_sizes,
    _wilson_interval,
)


class TestReciprocalCIRPreparation(unittest.TestCase):
    def test_sums_ue_array_ports_and_preserves_path_axis(self):
        # DL CIR: [rx, rx_ant(UE), tx, tx_ant(BS), path, time]
        a = np.zeros((1, 2, 1, 3, 4, 1), dtype=np.complex64)
        for ue_port in range(2):
            for bs_port in range(3):
                for path in range(4):
                    a[0, ue_port, 0, bs_port, path, 0] = (
                        (ue_port + 1) * (path + 1) + 1j * bs_port
                    )
        tau = np.arange(4, dtype=np.float32).reshape(1, 1, 4) * 1e-8

        a_ul, tau_ul, num_ue_ports = _prepare_reciprocal_ul_cir(a, tau)

        self.assertEqual(num_ue_ports, 2)
        self.assertEqual(a_ul.shape, (1, 1, 3, 1, 1, 4, 1))
        self.assertEqual(tau_ul.shape, (1, 1, 1, 4))
        # UE-port sum: (1 + 2)/sqrt(2), independently for each path.
        expected = (3 / np.sqrt(2)) * np.arange(1, 5)
        np.testing.assert_allclose(a_ul[0, 0, :, 0, 0, :, 0].real,
                                   np.tile(expected, (3, 1)))
        # Crucial regression: four path taps remain four, not one summed path.
        np.testing.assert_allclose(tau_ul[0, 0, 0], tau[0, 0])

    def test_expanded_tau_is_reduced_to_shared_geometric_delays(self):
        a = np.ones((1, 2, 1, 2, 3, 1), dtype=np.complex64)
        tau = np.broadcast_to(np.arange(3)[None, None, None, None, :],
                              (1, 2, 1, 2, 3)).astype(float)
        _, tau_ul, _ = _prepare_reciprocal_ul_cir(a, tau)
        self.assertEqual(tau_ul.shape, (1, 1, 1, 3))
        np.testing.assert_allclose(tau_ul[0, 0, 0], [0, 1, 2])

    def test_rejects_antenna_dependent_delay_values(self):
        a = np.ones((1, 2, 1, 1, 2, 1), dtype=np.complex64)
        tau = np.zeros((1, 2, 1, 1, 2), dtype=float)
        tau[:, 1, :, :, :] = 1e-8
        with self.assertRaisesRegex(ValueError, "antenna-independent"):
            _prepare_reciprocal_ul_cir(a, tau)

    def test_rejects_non_single_link(self):
        a = np.ones((2, 1, 1, 1, 2, 1), dtype=np.complex64)
        tau = np.ones((2, 1, 2), dtype=float)
        with self.assertRaisesRegex(ValueError, "single Tx-Rx link"):
            _prepare_reciprocal_ul_cir(a, tau)


class TestWilsonIntervals(unittest.TestCase):
    def test_zero_errors_has_nonzero_upper_bound(self):
        lo, hi = _wilson_interval(0, 100)
        self.assertEqual(lo, 0.0)
        self.assertGreater(hi, 0.0)
        self.assertLess(hi, 0.1)

    def test_all_errors_interval_contains_one(self):
        lo, hi = _wilson_interval(100, 100)
        self.assertLess(lo, 1.0)
        self.assertEqual(hi, 1.0)

    def test_invalid_counts(self):
        with self.assertRaises(ValueError):
            _wilson_interval(2, 1)


class TestAbsoluteLinkBudget(unittest.TestCase):
    def test_flat_unit_channel_derives_noise_and_ebno(self):
        result = _absolute_link_budget(
            mean_channel_gain=1.0,
            ue_tx_power_dbm=23.0,
            occupied_bandwidth_hz=18.36e6,
            receiver_noise_figure_db=7.0,
            bits_per_symbol=4,
            coderate=0.54,
        )
        expected_noise_dbm = 10 * np.log10(
            1.380649e-23 * 293.0 * 18.36e6 * 1e3
        ) + 7.0
        self.assertAlmostEqual(result["noisePowerDbm"], expected_noise_dbm, places=9)
        self.assertAlmostEqual(
            result["noisePowerDbm"],
            noise_power_dbm(18.36e6, 7.0),
            places=9,
        )
        self.assertAlmostEqual(result["combinedRxPowerDbm"], 23.0, places=9)
        self.assertAlmostEqual(
            result["effectiveSnrDb"], 23.0 - expected_noise_dbm, places=9
        )
        self.assertAlmostEqual(
            result["linkBudgetEbNoDb"],
            result["effectiveSnrDb"] - 10 * np.log10(4 * 0.54),
            places=9,
        )
        self.assertGreater(result["noiseVariance"], 0.0)

    def test_channel_gain_and_tx_power_affect_operating_point(self):
        reference = _absolute_link_budget(
            mean_channel_gain=1e-8,
            ue_tx_power_dbm=23.0,
            occupied_bandwidth_hz=10e6,
            receiver_noise_figure_db=7.0,
            bits_per_symbol=4,
            coderate=0.5,
        )
        doubled_gain = _absolute_link_budget(
            mean_channel_gain=2e-8,
            ue_tx_power_dbm=23.0,
            occupied_bandwidth_hz=10e6,
            receiver_noise_figure_db=7.0,
            bits_per_symbol=4,
            coderate=0.5,
        )
        higher_tx = _absolute_link_budget(
            mean_channel_gain=1e-8,
            ue_tx_power_dbm=26.0,
            occupied_bandwidth_hz=10e6,
            receiver_noise_figure_db=7.0,
            bits_per_symbol=4,
            coderate=0.5,
        )
        higher_nf = _absolute_link_budget(
            mean_channel_gain=1e-8,
            ue_tx_power_dbm=23.0,
            occupied_bandwidth_hz=10e6,
            receiver_noise_figure_db=10.0,
            bits_per_symbol=4,
            coderate=0.5,
        )
        self.assertAlmostEqual(
            doubled_gain["linkBudgetEbNoDb"] - reference["linkBudgetEbNoDb"],
            10 * np.log10(2), places=8,
        )
        self.assertAlmostEqual(
            higher_tx["linkBudgetEbNoDb"] - reference["linkBudgetEbNoDb"],
            3.0, places=8,
        )
        self.assertAlmostEqual(
            higher_nf["linkBudgetEbNoDb"] - reference["linkBudgetEbNoDb"],
            -3.0, places=8,
        )

    def test_invalid_channel_gain_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "non-zero"):
            _absolute_link_budget(
                mean_channel_gain=0.0,
                ue_tx_power_dbm=23.0,
                occupied_bandwidth_hz=1e6,
                receiver_noise_figure_db=7.0,
                bits_per_symbol=4,
                coderate=0.5,
            )


class TestSlotBatchSizes(unittest.TestCase):
    def test_exact_multiple(self):
        self.assertEqual(_slot_batch_sizes(64, 16), [16, 16, 16, 16])

    def test_remainder_is_preserved(self):
        self.assertEqual(_slot_batch_sizes(35, 16), [16, 16, 3])

    def test_small_sweep_point_uses_single_batch(self):
        self.assertEqual(_slot_batch_sizes(8, 16), [8])

    def test_invalid_total_or_batch_size(self):
        with self.assertRaises(ValueError):
            _slot_batch_sizes(0, 16)
        with self.assertRaises(ValueError):
            _slot_batch_sizes(10, 0)
