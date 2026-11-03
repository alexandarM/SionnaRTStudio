import assert from 'node:assert/strict';
import { enuToLatLon, getSectorHue, latLonToENU } from '../src/utils.ts';

const anchor = { latitude: 12.0, longitude: -30.0 };
const controls = [
  { latitude: 12.0, longitude: -30.0 },
  { latitude: 12.0012345, longitude: -29.9976789 },
  { latitude: 11.9965432, longitude: -30.0032109 },
  { latitude: 12.008, longitude: -29.990 },
];

for (const point of controls) {
  const enu = latLonToENU(point.latitude, point.longitude, anchor);
  const recovered = enuToLatLon(enu, anchor);
  assert.ok(Math.abs(recovered.lat - point.latitude) < 1e-10, 'latitude round-trip error');
  assert.ok(Math.abs(recovered.lon - point.longitude) < 1e-10, 'longitude round-trip error');
}

assert.deepEqual(latLonToENU(anchor.latitude, anchor.longitude, anchor), { x: 0, y: 0, z: 0 });
const east = latLonToENU(anchor.latitude, anchor.longitude + 0.001, anchor);
const north = latLonToENU(anchor.latitude + 0.001, anchor.longitude, anchor);
assert.ok(east.x > 0 && Math.abs(east.y) < 1e-9, 'longitude increase must move East');
assert.ok(north.y > 0 && Math.abs(north.x) < 1e-9, 'latitude increase must move North');
assert.ok(east.x > 100 && east.x < 115, '0.001° longitude at the synthetic equatorial anchor should be about 111 m');
assert.ok(north.y > 100 && north.y < 120, '0.001° latitude should be about 111 m');

const stableId = 'site-001-sector-02';
assert.equal(getSectorHue(0, stableId), getSectorHue(18, stableId), 'same sector ID must keep its hue across TX order changes');
assert.notEqual(getSectorHue(0, stableId), getSectorHue(0, 'site-002-sector-02'), 'different sector IDs should not share a hue');

console.log('Georeference checks passed: WGS84 ENU round-trip, axes/signs, local scales and stable sector palette.');
