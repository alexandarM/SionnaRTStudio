import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.models import ENUVector, MeasurementRayTraceRequest, SolverOptions, Transmitter
from backend.measurement_simulation import run_measurement_location_raytrace
from backend.measurement_validation import store_measurement_dataset, clear_measurement_store
from backend.measurement_matching import build_radio_identity_profiles
from backend.measurement_simulation import nr_arfcn_to_ghz, select_measurement_sample_points
from backend.measurement_validation import parse_measurement_csv


class TestMeasurementRayTraceSampling(unittest.TestCase):
    def setUp(self):
        csv_text = (
            "timestamp_utc,rat,pci,band,arfcn,cell_id,anchor_pci,earfcn,rsrp_dbm,rsrq_db,sinr_db,lat,lon,position_source\n"
            "2025-01-01T13:00:00Z,NR5G-NSA,17,78,640000,AB12CD,23,1300,-83,-10,13,12.345000,-45.678000,synthetic_test_fixture\n"
            "2025-01-01T13:00:02Z,NR5G-NSA,17,78,640000,AB12CD,23,1300,-82,-10,14,12.345000,-45.678000,synthetic_test_fixture\n"
            "2025-01-01T13:00:04Z,NR5G-NSA,17,78,640000,AB12CD,23,1300,-86,-11,10,12.345100,-45.678100,synthetic_test_fixture\n"
            "2025-01-01T13:00:06Z,NR5G-NSA,17,78,640000,AB12CD,23,1300,-88,-12,8,12.345200,-45.678200,synthetic_test_fixture\n"
            "2025-01-01T13:00:08Z,NR5G-NSA,17,78,640000,AB12CD,23,1300,-91,-13,5,12.345300,-45.678300,synthetic_test_fixture\n"
            "2025-01-01T13:00:10Z,NR5G-NSA,34,78,640000,CD34EF,24,1300,-98,-14,4,12.346000,-45.679000,synthetic_test_fixture\n"
        )
        self.dataset = parse_measurement_csv("sample.csv", csv_text)
        store_measurement_dataset(self.dataset)
        self.profile = next(p for p in build_radio_identity_profiles(self.dataset) if p["pci"] == 17)

    def tearDown(self):
        clear_measurement_store()

    def test_nr_arfcn_raster_conversion(self):
        self.assertAlmostEqual(nr_arfcn_to_ghz(640000), 3.6, places=7)
        self.assertAlmostEqual(nr_arfcn_to_ghz(0), 0.0, places=7)
        self.assertIsNone(nr_arfcn_to_ghz(-1))

    def test_unique_positions_are_aggregated_and_temporally_stratified(self):
        result = select_measurement_sample_points(
            self.dataset,
            profile_id=self.profile["profileId"],
            anchor_latitude=12.345,
            anchor_longitude=-45.678,
            scene_bounds={"xMin": -1000, "xMax": 1000, "yMin": -1000, "yMax": 1000},
            sample_count=2,
        )
        self.assertEqual(result["allDistinctEligiblePositions"], 4)
        self.assertEqual(result["eligiblePositionsInsideScene"], 4)
        self.assertEqual(len(result["sampledLocations"]), 2)
        self.assertEqual(result["sampledLocations"][0]["sourceRowCount"], 2)
        self.assertAlmostEqual(result["sampledLocations"][0]["rsrpDbm"], -82.5)
        self.assertEqual(result["sampleStrategy"].startswith("Deterministic"), True)

    def test_scene_bounds_filter_outside_locations(self):
        result = select_measurement_sample_points(
            self.dataset,
            profile_id=self.profile["profileId"],
            anchor_latitude=12.345,
            anchor_longitude=-45.678,
            scene_bounds={"xMin": -20, "xMax": 20, "yMin": -20, "yMax": 20},
            sample_count=100,
        )
        self.assertGreater(result["excludedOutsideScenePositions"], 0)
        self.assertLess(result["eligiblePositionsInsideScene"], result["allDistinctEligiblePositions"])
        self.assertEqual(len(result["sampledLocations"]), result["eligiblePositionsInsideScene"])

    def test_raytrace_result_shape_with_mocked_solver(self):
        tx = Transmitter(
            id="tx_test", name="Test TX", enu=ENUVector(x=0, y=0, z=25),
            height=25, heightReference="scene_z", powerDbm=46,
            antennaArraySize=(1, 1), beamsteeringAzimuth=15,
            beamsteeringElevation=-5, frequencyBand="n78",
        )
        req = MeasurementRayTraceRequest(
            anchorLatitude=12.345, anchorLongitude=-45.678,
            sceneBounds={"xMin": -1000, "xMax": 1000, "yMin": -1000, "yMax": 1000},
            profileId=self.profile["profileId"], tx=tx, buildings=[], freqGhz=3.5,
            maxDepth=3, options=SolverOptions(), materials=[], rxHeightM=1.5,
            sampleCount=2, rxArraySize=(1, 1),
        )
        metrics = SimpleNamespace(
            totalRxPowerDbm=-81.5, losStatus="LOS", numPaths=3,
            rmsDelaySpreadNs=45.0, strongestPathPowerDbm=-84.0,
            strongestPathType="LOS",
        )
        fake_paths = [object()]
        with patch("backend.measurement_simulation.build_scene", return_value=object()), \
             patch("backend.measurement_simulation._device_z", return_value=25.0), \
             patch("backend.measurement_simulation._set_tx_array", return_value=1), \
             patch("backend.measurement_simulation._set_rx_array", return_value=1), \
             patch("backend.measurement_simulation._beam_target", return_value=[0, 100, 25]), \
             patch("backend.measurement_simulation._solve_batched", return_value=[[(fake_paths, 0.0)] for _ in range(2)]), \
             patch("backend.measurement_simulation._channel_metrics", return_value=metrics):
            result = run_measurement_location_raytrace(self.dataset["datasetId"], req)
        self.assertEqual(result["sampleCountReturned"], 2)
        self.assertEqual(result["validSimulationCount"], 2)
        self.assertEqual(result["frequencyGhz"], 3.6)
        self.assertAlmostEqual(result["medianSimulatedTotalRxPowerDbm"], -81.5)
        self.assertEqual(len(result["results"]), 2)
        self.assertTrue(result["results"][0]["simulationValid"])
        config = result["rfConfiguration"]
        self.assertEqual(config["frequency"]["effectiveGhz"], 3.6)
        self.assertEqual(config["tx"]["heightReferenceInput"], "scene_z")
        self.assertEqual(config["tx"]["positionEnuM"]["up"], 25.0)
        self.assertEqual(config["tx"]["arraySize"], [1, 1])
        self.assertEqual(config["tx"]["pattern"], "tr38901")
        self.assertEqual(config["rx"]["arraySize"], [1, 1])
        self.assertEqual(config["pathSolver"]["maxDepth"], 3)
        self.assertEqual(config["pathSolver"]["pathSamplesPerSource"], 1_000_000)
        self.assertEqual(config["pathSolver"]["pathSeed"], 42)
        self.assertEqual(len(result["configurationFingerprint"]), 64)
        self.assertEqual(result["results"][0]["configurationFingerprint"], result["configurationFingerprint"])
        self.assertEqual(config["physicalCalibrationStatus"], "incomplete")
        self.assertTrue(any("power reference" in warning.lower() for warning in result["warnings"]))

        changed_seed_req = req.model_copy(
            update={"options": req.options.model_copy(update={"pathSeed": 43})}
        )
        with patch("backend.measurement_simulation.build_scene", return_value=object()), \
             patch("backend.measurement_simulation._device_z", return_value=25.0), \
             patch("backend.measurement_simulation._set_tx_array", return_value=1), \
             patch("backend.measurement_simulation._set_rx_array", return_value=1), \
             patch("backend.measurement_simulation._beam_target", return_value=[0, 100, 25]), \
             patch("backend.measurement_simulation._solve_batched", return_value=[[(fake_paths, 0.0)] for _ in range(2)]), \
             patch("backend.measurement_simulation._channel_metrics", return_value=metrics):
            changed_result = run_measurement_location_raytrace(self.dataset["datasetId"], changed_seed_req)
        self.assertNotEqual(result["configurationFingerprint"], changed_result["configurationFingerprint"])

        changed_seed_req = req.model_copy(
            update={"options": req.options.model_copy(update={"pathSeed": 43})}
        )
        with patch("backend.measurement_simulation.build_scene", return_value=object()), \
             patch("backend.measurement_simulation._device_z", return_value=25.0), \
             patch("backend.measurement_simulation._set_tx_array", return_value=1), \
             patch("backend.measurement_simulation._set_rx_array", return_value=1), \
             patch("backend.measurement_simulation._beam_target", return_value=[0, 100, 25]), \
             patch("backend.measurement_simulation._solve_batched", return_value=[[(fake_paths, 0.0)] for _ in range(2)]), \
             patch("backend.measurement_simulation._channel_metrics", return_value=metrics):
            changed_result = run_measurement_location_raytrace(self.dataset["datasetId"], changed_seed_req)
        self.assertNotEqual(result["configurationFingerprint"], changed_result["configurationFingerprint"])


if __name__ == "__main__":
    unittest.main()
