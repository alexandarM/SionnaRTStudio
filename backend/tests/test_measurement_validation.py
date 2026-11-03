import unittest

from backend.measurement_validation import (
    MeasurementImportError,
    clear_measurement_store,
    export_measurement_csv,
    get_measurement_dataset,
    get_measurement_rows,
    parse_measurement_csv,
    store_measurement_dataset,
)


class TestMeasurementImport(unittest.TestCase):
    def tearDown(self):
        clear_measurement_store()

    def test_imports_quectel_schema_and_flags_sentinels(self):
        csv_text = (
            "timestamp_utc,rat,pci,band,arfcn,rsrp_dbm,rsrq_db,sinr_db,lat,lon,position_source\n"
            "2025-01-01 13:00:00,NR5G-NSA,17,78,640000,-83,-10,15,12.34,-45.67,synthetic_test_fixture\n"
            "2025-01-01 13:00:02,LTE,,,, -32768,-32768,-6573.6,12.3401,-45.6701,synthetic_test_fixture\n"
        )
        ds = parse_measurement_csv("test_gps.csv", csv_text.encode())
        self.assertEqual(ds["summary"]["totalRows"], 2)
        self.assertEqual(ds["summary"]["radioValidRows"], 1)
        self.assertEqual(ds["summary"]["locationValidRows"], 2)
        self.assertEqual(ds["qualityRows"][0]["pci"], 17)
        self.assertTrue(ds["qualityRows"][0]["eligibleForSpatialValidation"])
        self.assertFalse(ds["qualityRows"][1]["radioValid"])
        self.assertIn("sentinel_rsrp_dbm", ds["qualityRows"][1]["qualityFlags"])
        self.assertIn("sentinel_sinr_db", ds["qualityRows"][1]["qualityFlags"])

    def test_accepts_semicolon_delimited_aliases(self):
        content = (
            "timestamp;technology;physical_cell_id;rsrp;latitude;longitude\n"
            "2025-01-01T13:00:00Z;NR5G-NSA;17;-80;45.24;19.84\n"
        )
        ds = parse_measurement_csv("alias.csv", content)
        self.assertEqual(ds["summary"]["totalRows"], 1)
        self.assertEqual(ds["qualityRows"][0]["rsrpDbm"], -80.0)
        self.assertTrue(ds["qualityRows"][0]["locationValid"])

    def test_duplicates_are_flagged_not_dropped(self):
        content = (
            "timestamp_utc,rat,pci,rsrp_dbm,lat,lon\n"
            "2025-01-01 13:00:00,NR5G-NSA,17,-80,12.34,-45.67\n"
            "2025-01-01 13:00:00,NR5G-NSA,17,-81,12.34,-45.67\n"
        )
        ds = parse_measurement_csv("duplicates.csv", content)
        self.assertEqual(ds["summary"]["totalRows"], 2)
        self.assertEqual(ds["summary"]["duplicateTimestampGroups"], 1)
        self.assertEqual(ds["summary"]["duplicateTimestampExtraRows"], 1)

    def test_raw_file_without_gps_is_not_spatially_eligible(self):
        content = (
            "timestamp_utc,rat,pci,rsrp_dbm,lat,lon\n"
            "2025-01-01 13:00:00,NR5G-NSA,17,-80,,\n"
        )
        ds = parse_measurement_csv("raw.csv", content)
        self.assertEqual(ds["summary"]["radioValidRows"], 1)
        self.assertEqual(ds["summary"]["locationValidRows"], 0)
        self.assertFalse(ds["qualityRows"][0]["eligibleForSpatialValidation"])

    def test_rejects_missing_required_fields(self):
        with self.assertRaises(MeasurementImportError):
            parse_measurement_csv("bad.csv", "time,pci,sinr\n13:00,17,10\n")

    def test_store_filter_and_export_preserve_all_rows(self):
        content = (
            "timestamp_utc,rat,pci,rsrp_dbm,lat,lon\n"
            "2025-01-01 13:00:00,NR5G-NSA,17,-80,12.34,-45.67\n"
            "2025-01-01 13:00:02,NR5G-NSA,34,-90,12.35,-45.68\n"
        )
        ds = parse_measurement_csv("filters.csv", content)
        store_measurement_dataset(ds)
        self.assertIsNotNone(get_measurement_dataset(ds["datasetId"]))
        rows = get_measurement_rows(ds["datasetId"], pci=17, spatial_only=True)
        self.assertEqual(rows["total"], 1)
        exported = export_measurement_csv(ds["datasetId"], spatial_only=True)
        self.assertIn("validation_eligible_for_spatial_validation", exported)
        self.assertEqual(exported.count("\n"), 3)

    def test_empty_and_large_inputs_rejected(self):
        with self.assertRaises(MeasurementImportError):
            parse_measurement_csv("empty.csv", b"  ")
        with self.assertRaises(MeasurementImportError):
            parse_measurement_csv("big.csv", b"x" * (25 * 1024 * 1024 + 1))


if __name__ == "__main__":
    unittest.main()

class TestMeasurementGeospatialAudit(unittest.TestCase):
    def setUp(self):
        self.csv_text = (
            "timestamp_utc,rat,pci,rsrp_dbm,lat,lon,altitude_m,position_source\n"
            "2025-01-01 13:00:00,NR5G-NSA,17,-80,10.000000,21.000000,120,synthetic_test_fixture\n"
            "2025-01-01 13:00:02,NR5G-NSA,17,-82,10.001000,21.001000,121,synthetic_test_fixture\n"
        )
        self.dataset = parse_measurement_csv("geo.csv", self.csv_text)
        store_measurement_dataset(self.dataset)

    def tearDown(self):
        clear_measurement_store()

    def test_wgs84_to_scene_enu_anchor_and_axis_signs(self):
        from backend.measurement_validation import wgs84_to_scene_enu
        east0, north0 = wgs84_to_scene_enu(10.000, 21.000, 10.000, 21.000)
        east, north = wgs84_to_scene_enu(10.001, 21.001, 10.000, 21.000)
        self.assertAlmostEqual(east0, 0.0, places=8)
        self.assertAlmostEqual(north0, 0.0, places=8)
        self.assertGreater(east, 0.0)
        self.assertGreater(north, 0.0)
        self.assertGreater(east, 70.0)
        self.assertGreater(north, 100.0)

    def test_geospatial_audit_reports_enu_utm_and_scene_envelope(self):
        from backend.measurement_validation import compute_geospatial_audit
        result = compute_geospatial_audit(
            self.dataset["datasetId"],
            anchor_latitude=10.000,
            anchor_longitude=21.000,
            scene_bounds={"xMin": -10, "xMax": 200, "yMin": -10, "yMax": 200},
        )
        self.assertEqual(result["sourceCrs"].split()[0], "EPSG:4326")
        self.assertEqual(result["metricProjectedCrs"], "EPSG:32634")
        self.assertTrue(result["metricProjectedCrsApplicable"])
        self.assertEqual(result["locationRows"], 2)
        self.assertEqual(result["withinSceneEnvelopeRows"], 2)
        self.assertEqual(result["outsideSceneEnvelopeRows"], 0)
        self.assertTrue(result["anchorInsideSceneEnvelope"])
        self.assertAlmostEqual(result["preview"][0]["eastM"], 0.0, places=8)
        self.assertAlmostEqual(result["preview"][0]["northM"], 0.0, places=8)
        self.assertGreater(result["utm34nBounds"]["eastingMinM"], 400000)
        self.assertTrue(any("vertical datum" in warning.lower() for warning in result["warnings"]))

    def test_georeferenced_export_keeps_rows_and_does_not_fake_scene_z(self):
        from backend.measurement_validation import export_georeferenced_measurement_csv
        import csv
        import io
        exported = export_georeferenced_measurement_csv(
            self.dataset["datasetId"],
            anchor_latitude=10.000,
            anchor_longitude=21.000,
            scene_bounds={"xMin": -10, "xMax": 200, "yMin": -10, "yMax": 200},
        )
        rows = list(csv.DictReader(io.StringIO(exported)))
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[1]["scene_x_east_m"], "")
        self.assertEqual(rows[1]["scene_z_up_m"], "")
        self.assertEqual(rows[1]["georef_z_status"], "UNVERIFIED_VERTICAL_DATUM")
        self.assertEqual(rows[1]["within_scene_envelope"], "1")
