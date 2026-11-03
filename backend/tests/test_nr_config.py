import unittest

from backend.nr_config import (
    approximate_minimum_cp_seconds,
    build_sweep_points,
    resolve_fr1_resource_grid,
    validate_mcs_index,
)


class TestFR1ResourceGrid(unittest.TestCase):
    def test_20mhz_30khz_maps_to_51_prbs(self):
        grid = resolve_fr1_resource_grid(20, 30_000)
        self.assertEqual(grid.num_prb, 51)
        self.assertEqual(grid.num_subcarriers, 612)
        self.assertEqual(grid.occupied_bandwidth_hz, 18_360_000)
        self.assertEqual(grid.numerology, 1)
        self.assertAlmostEqual(grid.slot_duration_seconds, 0.0005)

    def test_20mhz_15khz_maps_to_106_prbs(self):
        grid = resolve_fr1_resource_grid(20, 15_000)
        self.assertEqual(grid.num_prb, 106)
        self.assertEqual(grid.num_subcarriers, 1272)
        self.assertAlmostEqual(grid.slot_duration_seconds, 0.001)

    def test_supported_bandwidth_edges(self):
        self.assertEqual(resolve_fr1_resource_grid(5, 30_000).num_prb, 11)
        self.assertEqual(resolve_fr1_resource_grid(100, 30_000).num_prb, 273)
        self.assertEqual(resolve_fr1_resource_grid(100, 60_000).num_prb, 135)

    def test_invalid_combinations_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "SCS must be 15, 30, or 60"):
            resolve_fr1_resource_grid(20, 120_000)
        with self.assertRaisesRegex(ValueError, "Allowed bandwidths"):
            resolve_fr1_resource_grid(55, 30_000)

    def test_mcs_table_ranges(self):
        validate_mcs_index(1, 28)
        validate_mcs_index(2, 27)
        validate_mcs_index(3, 28)
        with self.assertRaises(ValueError):
            validate_mcs_index(2, 28)

    def test_extended_cp_is_60khz_only(self):
        self.assertAlmostEqual(approximate_minimum_cp_seconds(60_000, "extended"),
                               4.1666666667e-6)
        with self.assertRaises(ValueError):
            approximate_minimum_cp_seconds(30_000, "extended")


class TestSweepPointBuilder(unittest.TestCase):
    def test_half_db_step_is_decimal_safe_and_includes_endpoint(self):
        self.assertEqual(
            build_sweep_points(-1.0, 1.0, 0.5),
            [-1.0, -0.5, 0.0, 0.5, 1.0],
        )

    def test_one_db_and_two_db_steps(self):
        self.assertEqual(build_sweep_points(-2, 2, 1), [-2, -1, 0, 1, 2])
        self.assertEqual(build_sweep_points(-2, 4, 2), [-2, 0, 2, 4])

    def test_single_point_sweep(self):
        self.assertEqual(build_sweep_points(0, 0, 0.5), [0.0])

    def test_rejects_non_divisible_range(self):
        with self.assertRaisesRegex(ValueError, "exactly divisible"):
            build_sweep_points(-1, 1, 0.3)

    def test_rejects_too_many_points(self):
        with self.assertRaisesRegex(ValueError, "limited to 41"):
            build_sweep_points(0, 21, 0.5)

    def test_rejects_invalid_values(self):
        for args in ((0, 1, 0), (2, 1, 1), (0, float("nan"), 1)):
            with self.assertRaises(ValueError):
                build_sweep_points(*args)
