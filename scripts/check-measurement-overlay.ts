import assert from 'node:assert/strict';
import {
  buildAllMeasurementOverlayPoints,
  buildMeasurementOverlayPoints,
  MeasurementOverlaySourceRow,
} from '../src/lib/measurementOverlay';

const profile = {
  rat: 'NR5G-NSA', pci: 17, band: 78, arfcn: 640000,
  lteAnchorCellId: 'AB12CD', lteAnchorPci: 23, lteAnchorEarfcn: 1300,
};

const makeRow = (
  rowIndex: number,
  lat: number | null,
  lon: number | null,
  rsrpDbm: number | null,
  sinrDb: number | null,
  overrides: Record<string, string> = {},
  eligible = true,
  rat = 'NR5G-NSA',
  pci = '17',
): MeasurementOverlaySourceRow => ({
  rowIndex,
  quality: {
    timestampUtc: `2025-01-01T10:${String(rowIndex % 60).padStart(2, '0')}:00Z`,
    rat, pci: Number(pci), band: 78, arfcn: 640000,
    rsrpDbm, rsrqDb: -11, sinrDb, rssiDbm: -60,
    lat, lon, radioValid: rsrpDbm != null, locationValid: lat != null && lon != null,
    eligibleForSpatialValidation: eligible, qualityFlags: rsrpDbm == null ? ['sentinel_rsrp_dbm'] : [],
  },
  raw: {
    rat, pci, band: '78', arfcn: '640000',
    cell_id: 'AB12CD', anchor_pci: '23', earfcn: '1300', ...overrides,
  },
});

const fixture = [
  makeRow(0, 12.344905, -45.678438, -80, 10),
  makeRow(1, 12.344905, -45.678438, -76, 14), // same GPS: aggregate median
  makeRow(2, 12.344810, -45.678347, -74, 18),
  makeRow(3, 12.344810, -45.678347, -71, 21, { cell_id: 'AB12CE' }), // other LTE anchor
  makeRow(4, 12.344700, -45.678300, null, 16, {}, false), // QC-invalid but has GPS
  makeRow(5, null, null, -90, 8, {}, false), // no GPS: cannot be mapped
  makeRow(6, 12.344600, -45.678200, -90, 8, {}, false, 'LTE', '23'),
];

const unique = buildMeasurementOverlayPoints(fixture, profile);
assert.equal(unique.length, 2, 'Unique mode should show only valid positions in the exact identity profile');
const grouped = unique.find((point) => point.sampleCount === 2);
const single = unique.find((point) => point.sampleCount === 1);
assert.ok(grouped, 'Coincident measurements should be grouped');
assert.equal(grouped.rsrpDbm, -78, 'Grouped RSRP should use the median');
assert.equal(grouped.sinrDb, 12, 'Grouped SINR should use the median');
assert.equal(grouped.samples.length, 2, 'Grouped point retains all original measurement records');
assert.deepEqual(grouped.samples.map((sample) => sample.rowIndex), [0, 1]);
assert.ok(single, 'The other unique GPS location should remain a single marker');

const individual = buildMeasurementOverlayPoints(fixture, profile, 'individual');
assert.equal(individual.length, 3, 'Individual mode should show all eligible rows in the exact radio identity context');
assert.equal(individual[0].samples.length, 1, 'Every individual marker represents one source row');
assert.equal(individual.filter((point) => point.latitude === 12.344905).length, 2, 'Coincident rows keep identical coordinates');
assert.notEqual(individual[0].id, individual[1].id, 'Individual source rows have unique marker IDs');

const allRows = buildAllMeasurementOverlayPoints(fixture);
assert.equal(allRows.length, 6, 'All-records mode shows every row with GPS, including invalid RF rows');
const invalid = allRows.find((point) => point.samples[0].rowIndex === 4);
assert.ok(invalid, 'QC-invalid row should remain visible when all validity states are included');
assert.equal(invalid.rsrpDbm, null, 'Invalid RSRP remains null; it is not fabricated');
assert.equal(buildAllMeasurementOverlayPoints(fixture, { validOnly: true }).length, 5, 'Valid-only filter excludes invalid RSRP rows');
assert.equal(buildAllMeasurementOverlayPoints(fixture, { rat: 'LTE' }).length, 1, 'RAT filter is applied');
assert.equal(buildAllMeasurementOverlayPoints(fixture, { pci: 17 }).length, 5, 'PCI filter is applied');

console.log('Measurement 3D overlay checks passed: unique, individual, all-record, QC and coincident-coordinate modes.');
