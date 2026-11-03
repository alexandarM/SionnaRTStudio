"""Regression tests for radio-map post-processing performance semantics."""
import unittest

from backend.models import RadioMapCell


class TestRadioMapCellLosSemantics(unittest.TestCase):
    def test_los_is_unknown_when_radio_map_solver_does_not_supply_it(self):
        cell = RadioMapCell(x=1.0, y=2.0, z=1.5, powerDbm=-82.0)
        self.assertIsNone(cell.isLos)

    def test_explicit_los_value_remains_supported_for_legacy_data(self):
        los = RadioMapCell(x=1.0, y=2.0, z=1.5, powerDbm=-82.0, isLos=True)
        nlos = RadioMapCell(x=1.0, y=2.0, z=1.5, powerDbm=-100.0, isLos=False)
        self.assertIs(los.isLos, True)
        self.assertIs(nlos.isLos, False)

    def test_unknown_los_serializes_as_json_null(self):
        cell = RadioMapCell(x=1.0, y=2.0, z=1.5, powerDbm=-82.0)
        self.assertIn('"isLos":null', cell.model_dump_json())


if __name__ == "__main__":
    unittest.main()
