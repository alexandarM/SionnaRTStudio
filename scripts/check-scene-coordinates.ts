import {
  createSceneCoordinateTransform,
  sourceBoundsToCanonical,
  sourcePointToCanonical,
  canonicalPointToSource,
  sourceVectorToCanonical,
  sourceNormalToCanonical,
  sourceRotationToCanonical,
  type SceneCoordinateFrame,
} from '../src/utils/sceneCoordinates.ts';

function equal3(actual: readonly number[], expected: readonly number[], label: string) {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(actual[i] - expected[i]) > 1e-9) {
      throw new Error(`${label}: [${actual}] != [${expected}]`);
    }
  }
}

const classroom: SceneCoordinateFrame = {
  upAxis: '+Y', forwardAxis: '+Z', units: 'm', handedness: 'right', origin: [0, 0, 0],
};
const t = createSceneCoordinateTransform(classroom);
equal3(sourcePointToCanonical([2, 1.2, 3], t), [3, 2, 1.2], 'Y-up classroom transform');
equal3(sourceVectorToCanonical([0, 1, 0], t), [0, 0, 1], 'up direction');
equal3(canonicalPointToSource([3, 2, 1.2], t), [2, 1.2, 3], 'inverse point');
equal3(sourceNormalToCanonical([0, 8, 0], t), [0, 0, 1], 'normal transform');

const centimetres = createSceneCoordinateTransform({
  upAxis: '+Z', forwardAxis: '+X', units: 'cm', handedness: 'right', origin: [100, 0, 0],
});
equal3(sourcePointToCanonical([200, 0, 0], centimetres), [1, 0, 0], 'centimetre scale and origin');

const customScale = createSceneCoordinateTransform({
  upAxis: '+Z', forwardAxis: '+X', units: 'custom', customScaleToMeters: 0.0025,
  handedness: 'right', origin: [0, 0, 0],
});
equal3(sourcePointToCanonical([4, 0, 0], customScale), [0.01, 0, 0], 'custom unit scale');

const leftHanded = createSceneCoordinateTransform({
  upAxis: '+Z', forwardAxis: '+X', units: 'm', handedness: 'left', origin: [0, 0, 0],
});
if (!leftHanded.requiresWindingFlip || leftHanded.determinant >= 0) {
  throw new Error('Left-handed frame must request mesh winding reversal');
}
equal3(sourcePointToCanonical([1, 2, 3], leftHanded), [1, -2, 3], 'left-handed reflection');

const bounds = sourceBoundsToCanonical({ minimum: [-400, 0, -200], maximum: [400, 150, 200] },
  createSceneCoordinateTransform({
    upAxis: '+Y', forwardAxis: '+Z', units: 'cm', handedness: 'right', origin: [0, 0, 0],
  }));
equal3(bounds.minimum, [-2, -4, 0], 'bounds minimum');
equal3(bounds.maximum, [2, 4, 1.5], 'bounds maximum');

const identity: any = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
equal3(sourceRotationToCanonical(identity, leftHanded)[0], [1, 0, 0], 'rotation conversion');

// Exercise all 24 valid signed up/forward combinations.
const axes = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
let validCount = 0;
for (const upAxis of axes) {
  for (const forwardAxis of axes) {
    try {
      const transform = createSceneCoordinateTransform({
        upAxis, forwardAxis, units: 'm', handedness: 'right', origin: [0, 0, 0],
      });
      if (Math.abs(Math.abs(transform.determinant) - 1) > 1e-9) throw new Error('Invalid determinant');
      validCount++;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('perpendicular')) throw error;
    }
  }
}
if (validCount !== 24) throw new Error(`Expected 24 valid axis pairs, got ${validCount}`);

console.log('Universal scene-coordinate adapter: PASS');
console.log('Canonical frame: RH, +Z up, +X forward, metres');
console.log('Supported valid signed up/forward combinations: 24');
