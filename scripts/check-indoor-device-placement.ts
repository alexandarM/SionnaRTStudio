import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  canonicalQuaternionToThree,
  canonicalToThreePosition,
  classifyIndoorSurface,
  offsetCanonicalPosition,
  surfaceNormalToCanonicalQuaternion,
  threeDirectionToCanonical,
  threeQuaternionToCanonical,
  threeToCanonicalPosition,
} from '../src/utils/indoorDevicePlacement';

const EPS = 1e-6;
function close(actual: number, expected: number, message: string) {
  assert.ok(Math.abs(actual - expected) <= EPS, `${message}: expected ${expected}, got ${actual}`);
}
function closeVector(actual: THREE.Vector3, expected: THREE.Vector3, message: string) {
  close(actual.x, expected.x, `${message}.x`);
  close(actual.y, expected.y, `${message}.y`);
  close(actual.z, expected.z, `${message}.z`);
}

// Canonical Sionna scene-local coordinates are RH, metres, +Z up. The shared
// ThreeStudio viewport is Y-up; the adapter must round-trip arbitrary points.
for (const point of [
  [0, 0, 0], [1, 2, 3], [-4.29, -4.08, 1.455], [12.5, -0.75, 2.1],
] as [number, number, number][]) {
  const roundTrip = threeToCanonicalPosition(canonicalToThreePosition(point));
  point.forEach((value, index) => close(roundTrip[index], value, `position round-trip [${point}] axis ${index}`));
}

const expectedDirections = [
  { three: new THREE.Vector3(0, 1, 0), canonical: [0, 0, 1] as [number, number, number] },
  { three: new THREE.Vector3(1, 0, 0), canonical: [1, 0, 0] as [number, number, number] },
  { three: new THREE.Vector3(0, 0, -1), canonical: [0, 1, 0] as [number, number, number] },
];
for (const item of expectedDirections) {
  const actual = threeDirectionToCanonical(item.three);
  item.canonical.forEach((value, index) => close(actual[index], value, `direction transform axis ${index}`));
}

assert.equal(classifyIndoorSurface(new THREE.Vector3(0, 1, 0)), 'floor');
assert.equal(classifyIndoorSurface(new THREE.Vector3(0, -1, 0)), 'ceiling');
assert.equal(classifyIndoorSurface(new THREE.Vector3(1, 0, 0)), 'wall');
assert.equal(classifyIndoorSurface(new THREE.Vector3(0, 0, -1)), 'wall');
assert.equal(classifyIndoorSurface(new THREE.Vector3(0, 0.5, 0.866)), 'other');

// A device's local +Z (canonical antenna boresight) is mapped to Three +Y,
// then aligned with the selected surface normal in Three world coordinates.
for (const normal of [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
].map((v) => v.normalize())) {
  const canonicalQuaternion = surfaceNormalToCanonicalQuaternion(normal);
  const threeQuaternion = canonicalQuaternionToThree(canonicalQuaternion);
  const aligned = new THREE.Vector3(0, 1, 0).applyQuaternion(threeQuaternion).normalize();
  closeVector(aligned, normal, 'surface-aligned orientation');
  const roundTrip = threeQuaternionToCanonical(threeQuaternion);
  const roundTripQuaternion = canonicalQuaternionToThree(roundTrip);
  closeVector(
    new THREE.Vector3(0, 1, 0).applyQuaternion(roundTripQuaternion).normalize(),
    normal,
    'orientation round-trip',
  );
}

const hitPoint = new THREE.Vector3(1, 2, 3);
const hitNormal = new THREE.Vector3(0, 1, 0);
const offset = offsetCanonicalPosition(hitPoint, hitNormal, 0.045);
close(offset[0], 1, 'offset x');
close(offset[1], -3, 'offset y canonical');
close(offset[2], 2.045, 'offset z canonical');

console.log('Indoor device placement geometry checks: PASS (point/direction transforms, 6 surface orientations, normal classification, 4.5 cm offset)');
