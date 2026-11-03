import assert from 'node:assert/strict';
import {
  getDesiredPreviewTolerance,
  getPreviewChunkMeters,
  getPreviewCoarseTolerance,
  getPreviewBaseTolerance,
  getPreviewLoadRadius,
  getPreviewUnloadRadius,
  shouldStreamPreviewChunk,
  shouldUnloadPreviewChunk,
} from '../src/lib/previewLod.ts';

assert.equal(getPreviewChunkMeters(9_999), 250);
assert.equal(getPreviewChunkMeters(10_000), 500);
assert.equal(getPreviewCoarseTolerance(4_999), 1.25);
assert.equal(getPreviewCoarseTolerance(5_000), 2.0);
assert.equal(getPreviewBaseTolerance(true, 4_999), 1.25);
assert.equal(getPreviewBaseTolerance(true, 5_000), 2.0);
assert.equal(getPreviewBaseTolerance(false, 50_000), 0);

// Coarse -> medium/high and hysteretic downgrade paths.
assert.equal(getDesiredPreviewTolerance(2_000, null), null);
assert.equal(getDesiredPreviewTolerance(1_500, null), 0.55);
assert.equal(getDesiredPreviewTolerance(400, null), 0);
assert.equal(getDesiredPreviewTolerance(680, 0), 0);
assert.equal(getDesiredPreviewTolerance(1_000, 0), 0.55);
assert.equal(getDesiredPreviewTolerance(2_000, 0), null);
assert.equal(getDesiredPreviewTolerance(450, 0.55), 0);
assert.equal(getDesiredPreviewTolerance(500, 0.55), 0.55);
assert.equal(getDesiredPreviewTolerance(1_800, 0.55), 0.55);
assert.equal(getDesiredPreviewTolerance(2_000, 0.55), null);

assert.equal(getPreviewLoadRadius(100), 1_000);
assert.equal(getPreviewLoadRadius(5_000), 6_750);
assert.equal(getPreviewLoadRadius(26_000), 35_100);
assert.equal(getPreviewLoadRadius(500_000), 400_000);
assert.equal(getPreviewUnloadRadius(2_000), 3_500);

assert.equal(shouldStreamPreviewChunk(700, 1_000, 500, false, 250), true);
assert.equal(shouldStreamPreviewChunk(2_000, 1_000, 100, true, 250), false);
assert.equal(shouldStreamPreviewChunk(1_000, 1_000, 100, true, 250), true);
assert.equal(shouldUnloadPreviewChunk(5_000, 3_500, 100, false), true);
assert.equal(shouldUnloadPreviewChunk(5_000, 3_500, 100, true), false);

console.log('Preview streaming / LOD policy checks: PASS (26 assertions)');
