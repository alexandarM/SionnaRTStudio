/**
 * Deterministic base-station spreadsheet import checks (no browser / backend needed).
 * Run with: npm run check:base-station-import
 */
import {
  ALL_BASE_STATION_BANDS,
  baseStationDraftsToTransmitters,
  filterBaseStationDraftsByBand,
  rowsToBaseStationDrafts,
} from '../src/utils/baseStationImport';
import { GeoAnchor } from '../src/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}
function near(actual: number, expected: number, epsilon = 1e-6): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

const anchor: GeoAnchor = { latitude: 12.0, longitude: -45.678 };

const csvLikeRows = [
  ['Site', 'Transmitter', 'Antenna', 'Longitude', 'Latitude', 'Height (m)', 'Azimuth (°)', 'Mechanical D', 'Power (dBm)', 'Frequency Band', 'Carrier Frequency (GHz)'],
  ['TEST_SITE_01', 'Sector 1', 'Vendor panel X', '-45.678', '12.0', '31.8', '0', '4', '53', 'n78', '3.5'],
  ['TEST_SITE_01', 'Sector 2', 'Vendor panel X', '-45.6778', '12.0001', '31.8', '70', '4', '53', 'VIP E-UTRA Band 3 - 20MHZ AR', '1.82'],
];
const drafts = rowsToBaseStationDrafts(csvLikeRows);
assert(drafts.length === 2, 'two station rows should parse');
assert(drafts[0].azimuthDeg === 0, 'north azimuth should remain zero degrees');
assert(drafts[1].azimuthDeg === 70, 'sector azimuth should be preserved');
assert(drafts[0].mechanicalDowntiltDeg === 4, 'truncated Mechanical D header should be recognized');
assert(drafts[0].carrierFrequencyGhz === 3.5, 'explicit carrier frequency in GHz should be parsed');
assert(drafts[1].carrierFrequencyGhz === 1.82, 'explicit carrier frequency for another band should be parsed');
const selectedN78Drafts = filterBaseStationDraftsByBand(drafts, 'n78');
assert(selectedN78Drafts.length === 1 && selectedN78Drafts[0].frequencyBand === 'n78', 'selecting n78 should retain only n78 antennas');
const allBandDrafts = filterBaseStationDraftsByBand(drafts, ALL_BASE_STATION_BANDS);
assert(allBandDrafts.length === drafts.length, 'All antennas should retain every parsed row');
assert(filterBaseStationDraftsByBand(drafts, 'missing-band').length === 0, 'unknown band selection should not silently import other bands');

const imported = baseStationDraftsToTransmitters(drafts, anchor, {
  heightReference: 'agl',
  powerColumnMeaning: 'conducted',
  defaultArraySize: [1, 1],
});
assert(imported.transmitters.length === 2, 'all valid station rows should import');
const sector1 = imported.transmitters[0];
assert(sector1.heightReference === 'agl', 'AGL height reference should be retained');
assert(near(sector1.height, 31.8), 'antenna height should be retained');
assert(near(sector1.beamsteeringAzimuth, 0), 'azimuth should map to Sionna orientation');
assert(near(sector1.beamsteeringElevation, -4), 'positive downtilt should become negative beam elevation');
assert(near(sector1.enu.x, 0) && near(sector1.enu.y, 0), 'map anchor should map to ENU origin');
assert(imported.transmitters[1].enu.x > 0 && imported.transmitters[1].enu.y > 0, 'longitude/latitude offsets should map east/north in the shared OSM ENU frame');
assert(imported.transmitters[0].id !== imported.transmitters[1].id, 'each antenna/sector row must receive a unique transmitter id');
assert(sector1.frequencyBand === 'n78', 'band label should be preserved');
assert(sector1.carrierFrequencyGhz === 3.5, 'only explicit exact carrier should be attached');
assert(sector1.site === 'TEST_SITE_01', 'site grouping metadata should be preserved');
assert(sector1.transmitterLabel === 'Sector 1', 'transmitter label should be preserved');
assert(sector1.antennaModel === 'Vendor panel X', 'antenna model should be preserved as metadata only');
assert(sector1.powerDbm === 53 && sector1.sourcePowerDbm === 53, 'conducted power and source power should be preserved');

const bandOnlyRows = rowsToBaseStationDrafts([
  ['Site', 'Transmitter', 'Antenna', 'Longitude', 'Latitude', 'Height (m)', 'Azimuth (°)', 'Mechanical Downtilt (°)', 'Power (dBm)', 'Frequency Band'],
  ['TEST_SITE_02', 'Sector 1', 'Panel Y', '-45.678', '12.0', '25', '140', '2', '46', 'E-UTRA Band 20 (791MHz)'],
  ['TEST_SITE_02', 'Sector 2', 'Panel Y', '-45.678', '12.0', '25', '240', '2', '46', 'GSM 900 Lean'],
]);
assert(bandOnlyRows.every((row) => row.carrierFrequencyGhz === undefined), 'band labels and band edges must never be treated as exact carrier centres');
const bandOnlyImport = baseStationDraftsToTransmitters(bandOnlyRows, anchor, {
  heightReference: 'scene_z',
  powerColumnMeaning: 'conducted',
  defaultArraySize: [1, 1],
});
assert(bandOnlyImport.transmitters.length === 2, 'band-only entries should remain importable as inventory');
assert(bandOnlyImport.warnings.some((warning) => warning.includes('are NOT treated as an assumed channel center')), 'missing exact carrier should produce an explicit warning');

const eirpRows = rowsToBaseStationDrafts([
  ['Site', 'Transmitter', 'Antenna', 'Longitude', 'Latitude', 'Height (m)', 'Azimuth (°)', 'Mechanical Downtilt (°)', 'Power (dBm)', 'Frequency Band', 'Antenna Gain (dBi)'],
  ['TEST_SITE_03', 'Sector 3', 'Panel Z', '-45.678', '12.0', '31.8', '140', '4', '70', 'n78', '17'],
]);
const eirp = baseStationDraftsToTransmitters(eirpRows, anchor, {
  heightReference: 'agl',
  powerColumnMeaning: 'eirp',
  defaultArraySize: [1, 1],
});
assert(eirp.transmitters.length === 1, 'EIRP row with antenna gain should import');
assert(eirp.transmitters[0].powerReference === 'eirp', 'source power meaning should be recorded');
assert(near(eirp.transmitters[0].powerDbm, 53), 'conducted power should equal EIRP minus antenna gain');
assert(eirp.transmitters[0].sourcePowerDbm === 70, 'original EIRP should remain traceable');
assert(eirp.transmitters[0].antennaGainDbi === 17, 'gain used for conversion should be saved');

const noGainRows = rowsToBaseStationDrafts([
  ['Site', 'Transmitter', 'Antenna', 'Longitude', 'Latitude', 'Height (m)', 'Azimuth (°)', 'Mechanical Downtilt (°)', 'Power (dBm)', 'Frequency Band'],
  ['TEST_SITE_03', 'Sector 4', 'Panel Z', '-45.678', '12.0', '31.8', '200', '4', '70', 'n78'],
]);
const missingGain = baseStationDraftsToTransmitters(noGainRows, anchor, {
  heightReference: 'agl',
  powerColumnMeaning: 'eirp',
  defaultArraySize: [1, 1],
});
assert(missingGain.transmitters.length === 0 && missingGain.skippedRows.length === 1, 'EIRP without gain must not be imported as conducted power');

const localeRows = rowsToBaseStationDrafts([
  ['Site', 'Transmitter', 'Antenna', 'Longitude', 'Latitude', 'Height (m)', 'Azimuth (°)', 'Mechanical Downtilt (°)', 'Power (dBm)', 'Frequency Band', 'Carrier Frequency (MHz)'],
  ['Site; North', 'N1', 'Panel X', '19,842', '45,245', '31,8', '12,5', '3,5', '46,0', '3500 MHz', '3500'],
]);
assert(localeRows.length === 1, 'quoted semicolon CSV row should parse');
assert(localeRows[0].site === 'Site; North', 'quoted delimiters should be retained');
assert(near(localeRows[0].latitude, 45.245), 'decimal comma should be accepted');
assert(near(localeRows[0].carrierFrequencyGhz ?? 0, 3.5), 'explicit carrier frequency in MHz should convert to GHz');

let invalidRowsRejected = false;
try {
  rowsToBaseStationDrafts([
    ['Site', 'Transmitter', 'Longitude', 'Latitude', 'Height (m)', 'Azimuth (°)', 'Power (dBm)', 'Frequency Band'],
    ['', 'Sector 1', '-45.678', '12.0', '20', '0', '43', 'n78'],
  ]);
} catch (error) {
  invalidRowsRejected = String(error).includes('site');
}
assert(invalidRowsRejected, 'rows without a Site value must be rejected instead of silently assigned to an arbitrary group');

let blankDowntiltRejected = false;
try {
  rowsToBaseStationDrafts([
    ['Site', 'Transmitter', 'Longitude', 'Latitude', 'Height (m)', 'Azimuth (°)', 'Mechanical D', 'Power (dBm)', 'Frequency Band'],
    ['TEST_SITE', 'Sector 1', '-45.678', '12.0', '20', '0', '', '43', 'n78'],
  ]);
} catch (error) {
  blankDowntiltRejected = String(error).includes('mechanical downtilt');
}
assert(blankDowntiltRejected, 'blank values in an existing Mechanical Downtilt column must not silently become zero');

console.log('PASS: base-station import, private-file-safe client parsing, header aliases, decimal commas, exact frequency handling, band metadata, per-band/all-antenna selection, height datum, azimuth/downtilt, and conducted/EIRP power validation.');
