import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildPlanarArrayPreview,
  getArrayElementVisualDimensions,
  getWavelengthMeters,
  localSteeringDirectionCanonical,
  rotateLocalDirectionToCanonicalWorld,
} from '../src/utils/antennaArrayPreview';

const lambda = getWavelengthMeters(3.5);
assert.ok(Math.abs(lambda - 0.085654988) < 1e-6, '3.5 GHz wavelength');

const single = buildPlanarArrayPreview([1, 1], 3.5, 'V');
assert.equal(single.elementCount, 1);
assert.equal(single.polarizationPorts, 1);
assert.equal(single.horizontalApertureMeters, 0);
assert.equal(single.verticalApertureMeters, 0);
assert.deepEqual(single.elementOffsetsCanonical, [[0, 0, 0]]);

const dual = buildPlanarArrayPreview([8, 4], 3.5, 'VH');
assert.equal(dual.elementCount, 32);
assert.equal(dual.polarizationPorts, 64);
assert.equal(dual.elementOffsetsCanonical.length, 32);
assert.ok(Math.abs(dual.spacingMeters - lambda * 0.5) < 1e-12);
assert.ok(Math.abs(dual.horizontalApertureMeters - 7 * lambda * 0.5) < 1e-12);
assert.ok(Math.abs(dual.verticalApertureMeters - 3 * lambda * 0.5) < 1e-12);
assert.ok(Math.abs(dual.elementOffsetsCanonical[0][0] + dual.elementOffsetsCanonical[31][0]) < 1e-12);
assert.ok(Math.abs(dual.elementOffsetsCanonical[0][1] + dual.elementOffsetsCanonical[31][1]) < 1e-12);

const cross = buildPlanarArrayPreview([2, 2], 28, 'cross');
assert.equal(cross.elementCount, 4);
assert.equal(cross.polarizationPorts, 8);
assert.ok(cross.spacingMeters < dual.spacingMeters, 'Spacing tracks frequency/wavelength');
const visual28 = getArrayElementVisualDimensions(cross.spacingMeters);
const visual35 = getArrayElementVisualDimensions(lambda * 0.5);
assert.ok(visual28.radiusMeters * 2 < cross.spacingMeters, '28 GHz element glyphs must not overlap at 0.5λ pitch');
assert.ok(visual35.radiusMeters > visual28.radiusMeters, 'Element glyphs scale with physical wavelength');
assert.ok(visual28.thicknessMeters > 0 && visual28.thicknessMeters < cross.spacingMeters);
assert.throws(() => getArrayElementVisualDimensions(0), RangeError);

const boresight = localSteeringDirectionCanonical(0, 0);
assert.deepEqual(boresight.map((v) => Number(v.toFixed(8))), [0, 0, 1]);
const rightSteer = localSteeringDirectionCanonical(90, 0);
assert.ok(Math.abs(rightSteer[0] - 1) < 1e-10 && Math.abs(rightSteer[2]) < 1e-10);
const elevated = localSteeringDirectionCanonical(0, 30);
assert.ok(Math.abs(elevated[1] - 0.5) < 1e-10);

const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const world = rotateLocalDirectionToCanonicalWorld([0, 0, 1], [yaw.x, yaw.y, yaw.z, yaw.w]);
assert.ok(Math.abs(world[0]) < 1e-10 && Math.abs(world[1]) < 1e-10 && Math.abs(world[2] - 1) < 1e-10);
const pitched = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const rotated = rotateLocalDirectionToCanonicalWorld([0, 0, 1], [pitched.x, pitched.y, pitched.z, pitched.w]);
assert.ok(Math.abs(rotated[0] - 1) < 1e-10 && Math.abs(rotated[2]) < 1e-10);

for (const bad of [[0, 1], [1, 0], [65, 1], [1, 65], [1.2, 2]]) {
  assert.throws(() => buildPlanarArrayPreview(bad, 3.5, 'V'), RangeError);
}
assert.throws(() => getWavelengthMeters(0), RangeError);
assert.throws(() => buildPlanarArrayPreview([2, 2], 3.5, 'V', 0), RangeError);

console.log('Antenna/RF preview checks: PASS (array layout, 0.5λ spacing, polarization ports, aperture, local steering, pose rotation, validation)');
