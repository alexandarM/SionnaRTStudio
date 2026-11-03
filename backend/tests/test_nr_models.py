import unittest

from pydantic import ValidationError

from backend.models import PhyBerRequest


BASE_REQUEST = {
    "tx": {"enu": {"x": 0.0, "y": 0.0, "z": 0.0}},
    "rx": {"enu": {"x": 10.0, "y": 0.0, "z": 1.5}},
    "buildings": [],
}


class TestPhyBerRequestValidation(unittest.TestCase):
    def test_nominal_20mhz_30khz_resolves_51_prbs(self):
        req = PhyBerRequest.model_validate({
            **BASE_REQUEST,
            "channelBandwidthMHz": 20,
            "subcarrierSpacing": 30_000,
        })
        self.assertEqual(req.numPrb, 51)

    def test_nominal_20mhz_15khz_resolves_106_prbs(self):
        req = PhyBerRequest.model_validate({
            **BASE_REQUEST,
            "channelBandwidthMHz": 20,
            "subcarrierSpacing": 15_000,
        })
        self.assertEqual(req.numPrb, 106)

    def test_legacy_prb_only_request_remains_supported(self):
        req = PhyBerRequest.model_validate({**BASE_REQUEST, "numPrb": 24})
        self.assertEqual(req.numPrb, 24)

    def test_table_two_mcs_28_is_rejected(self):
        with self.assertRaises(ValidationError):
            PhyBerRequest.model_validate({
                **BASE_REQUEST, "mcsTable": 2, "mcsIndex": 28,
            })

    def test_extended_cp_requires_60khz(self):
        with self.assertRaises(ValidationError):
            PhyBerRequest.model_validate({
                **BASE_REQUEST, "subcarrierSpacing": 30_000,
                "cyclicPrefix": "extended",
            })

    def test_invalid_fr1_bandwidth_scs_pair_is_rejected(self):
        with self.assertRaises(ValidationError):
            PhyBerRequest.model_validate({
                **BASE_REQUEST, "channelBandwidthMHz": 55,
                "subcarrierSpacing": 30_000,
            })

    def test_inverted_ebno_range_is_rejected(self):
        with self.assertRaises(ValidationError):
            PhyBerRequest.model_validate({
                **BASE_REQUEST, "snrMinDb": 8, "snrMaxDb": 2,
            })

    def test_absolute_channel_mode_accepts_ue_power_and_receiver_nf(self):
        req = PhyBerRequest.model_validate({
            **BASE_REQUEST,
            "channelMode": "absolute",
            "ueTxPowerDbm": 23.0,
            "receiverNoiseFigureDb": 7.0,
            "snrMinDb": -2,
            "snrMaxDb": 2,
            "snrStepDb": 0.5,
        })
        self.assertEqual(req.channelMode, "absolute")
        self.assertEqual(req.ueTxPowerDbm, 23.0)
        self.assertEqual(req.receiverNoiseFigureDb, 7.0)

    def test_non_divisible_sweep_step_is_rejected(self):
        with self.assertRaises(ValidationError):
            PhyBerRequest.model_validate({
                **BASE_REQUEST, "snrMinDb": -1, "snrMaxDb": 1,
                "snrStepDb": 0.3,
            })

    def test_absolute_ue_power_bounds_are_enforced(self):
        with self.assertRaises(ValidationError):
            PhyBerRequest.model_validate({
                **BASE_REQUEST, "channelMode": "absolute", "ueTxPowerDbm": 40,
            })


class TestPhyBerResultSerialization(unittest.TestCase):
    def test_absolute_mode_result_schema_accepts_link_budget_diagnostics(self):
        from backend.models import PhyBerResult

        result = PhyBerResult.model_validate({
            "points": [{
                "ebNoDb": 4.2,
                "linkBudgetOffsetDb": 0.0,
                "ber": 0.0,
                "bler": 0.0,
                "berCi95Lower": 0.0,
                "berCi95Upper": 0.01,
                "blerCi95Lower": 0.0,
                "blerCi95Upper": 0.19,
                "goodputMbps": 34.8,
                "bitErrors": 0,
                "bits": 100000,
                "blockErrors": 0,
                "blocks": 16,
            }],
            "mcsIndex": 14,
            "mcsTable": 1,
            "modulationOrder": 4,
            "targetCoderate": 0.54,
            "numPrb": 51,
            "numSubcarriers": 612,
            "subcarrierSpacingHz": 30000,
            "channelBandwidthMHz": 20,
            "occupiedBandwidthHz": 18_360_000,
            "nCellId": 1,
            "cyclicPrefix": "normal",
            "dmrsConfigType": 1,
            "dmrsAdditionalPosition": 0,
            "numSymbolsPerSlot": 14,
            "slotDurationSeconds": 0.0005,
            "maxExcessDelayNs": 160.4,
            "approxMinimumCpNs": 2350.0,
            "channelNormalized": False,
            "channelDirection": "reciprocal_uplink",
            "interferenceModel": "single_link_awgn_no_inter_cell_interference",
            "numRxAnt": 1,
            "numTxAnt": 1,
            "numUeArrayPorts": 1,
            "numPaths": 3,
            "slotsPerPoint": 16,
            "transportBlockBits": 17424,
            "seed": 42,
            "channelMode": "absolute",
            "sweepAxis": "link_budget_offset",
            "linkBudgetEbNoDb": 4.2,
            "effectiveSnrDb": 7.56,
            "rxPowerDbm": -75.0,
            "noisePowerDbm": -82.56,
            "noiseBandwidthHz": 18_360_000.0,
            "meanChannelGainDb": -98.0,
            "ueTxPowerDbm": 23.0,
            "receiverNoiseFigureDb": 7.0,
            "noiseTemperatureK": 293.0,
        })
        self.assertEqual(result.channelMode, "absolute")
        self.assertFalse(result.channelNormalized)
        self.assertEqual(result.points[0].linkBudgetOffsetDb, 0.0)
        self.assertEqual(result.noiseBandwidthHz, 18_360_000.0)
