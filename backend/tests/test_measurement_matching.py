import unittest

from backend.measurement_matching import (
    build_radio_identity_profiles,
    compute_measurement_matching_audit,
)
from backend.measurement_validation import (
    clear_measurement_store,
    parse_measurement_csv,
    store_measurement_dataset,
)


class TestMeasurementIdentityMatching(unittest.TestCase):
    def setUp(self):
        csv_text = (
            "timestamp_utc,rat,pci,band,arfcn,cell_id,anchor_pci,earfcn,rsrp_dbm,rsrq_db,sinr_db,lat,lon,position_source\n"
            "2025-01-01 13:00:00,NR5G-NSA,17,78,640000,AB12CD,23,1300,-83,-10,13,12.345000,-45.678000,synthetic_test_fixture\n"
            "2025-01-01 13:00:02,NR5G-NSA,17,78,640000,AB12CD,23,1300,-82,-10,14,12.345100,-45.678100,synthetic_test_fixture\n"
            "2025-01-01 13:00:04,NR5G-NSA,17,78,640000,AB12CE,25,1300,-86,-11,10,12.346000,-45.679000,synthetic_test_fixture\n"
            "2025-01-01 13:00:06,NR5G-NSA,34,78,640000,CD34EF,24,1300,-98,-14,4,12.347000,-45.680000,synthetic_test_fixture\n"
        )
        self.dataset = parse_measurement_csv("matching.csv", csv_text)
        store_measurement_dataset(self.dataset)

    def tearDown(self):
        clear_measurement_store()

    def test_identity_profiles_keep_lte_anchor_context_separate(self):
        profiles = build_radio_identity_profiles(self.dataset)
        p17 = [p for p in profiles if p["pci"] == 17]
        self.assertEqual(len(p17), 2)
        self.assertEqual(sum(p["rowCount"] for p in p17), 3)
        self.assertEqual({p["lteAnchorCellId"] for p in p17}, {"AB12CD", "AB12CE"})
        self.assertTrue(all(p["band"] == 78 and p["arfcn"] == 640000 for p in p17))

    def test_matching_audit_ranks_tx_candidates_without_auto_assignment(self):
        profiles = build_radio_identity_profiles(self.dataset)
        profile = next(p for p in profiles if p["pci"] == 17 and p["lteAnchorCellId"] == "AB12CD")
        txs = [
            {"id": "tx_north", "name": "North sector", "enu": {"x": 0, "y": 0, "z": 20},
             "beamsteeringAzimuth": 0, "frequencyBand": "n78"},
            {"id": "tx_unknown", "name": "Unknown band", "enu": {"x": 1000, "y": 1000, "z": 20},
             "beamsteeringAzimuth": 180, "frequencyBand": None},
        ]
        result = compute_measurement_matching_audit(
            self.dataset["datasetId"], anchor_latitude=12.345, anchor_longitude=-45.678,
            transmitters=txs, profile_id=profile["profileId"],
        )
        self.assertEqual(result["selectedProfile"]["rowCount"], 2)
        self.assertEqual(result["selectedProfile"]["eligibleRows"], 2)
        self.assertEqual(result["selectedProfile"]["distinctGpsPositions"], 2)
        self.assertEqual(len(result["candidateTransmitters"]), 2)
        self.assertEqual(result["candidateTransmitters"][0]["txId"], "tx_north")
        self.assertTrue(result["candidateTransmitters"][0]["frequencyBandMatch"])
        self.assertTrue(any("No automatic" in warning for warning in result["warnings"]))

    def test_selected_profile_requires_exact_identity_context(self):
        result = compute_measurement_matching_audit(
            self.dataset["datasetId"], anchor_latitude=12.345, anchor_longitude=-45.678,
            transmitters=[], rat="NR5G-NSA", pci=17,
        )
        self.assertIsNotNone(result["selectedProfile"])
        self.assertIn(result["selectedProfile"]["lteAnchorCellId"], {"AB12CD", "AB12CE"})
        self.assertEqual(result["candidateTransmitters"], [])


if __name__ == "__main__":
    unittest.main()
