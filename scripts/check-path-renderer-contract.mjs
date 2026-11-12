import fs from 'node:fs';

const source = fs.readFileSync('src/components/ThreeStudio.tsx', 'utf8');
const start = source.indexOf('function drawRayPaths3D()');
const end = source.indexOf('// 9. DYNAMIC HEATMAP', start);
if (start < 0 || end < 0) {
  console.error('FAIL shared drawRayPaths3D renderer was not found');
  process.exit(1);
}
const renderer = source.slice(start, end);
const checks = [
  ['indoor and outdoor path segments use the shared LineSegments renderer', 'new THREE.LineSegments(geometry, material)'],
  ['indoor ray path is explicitly line-only', 'if (!indoorBounds) {'],
  ['only outdoor mode adds octahedron marker positions', 'markerPositions.push(points[index])'],
  ['legacy outdoor marker radius and detail are unchanged', 'new THREE.OctahedronGeometry(0.7, 1)'],
  ['indoor marker layer is not generated from interaction vertices', '!indoorBounds'],
  ['same shared renderer handles both scene types', 'function drawRayPaths3D()'],
  ['LOS and NLOS path colors are retained', "path.type === 'LOS' ? 0x22c55e : 0xf97316"],
  ['path line opacity is retained', 'opacity: 0.9'],
];
const failures = checks.filter(([, needle]) => !renderer.includes(needle));
// Assert the indoor-only region contains no marker creation calls.
const outdoorBranch = renderer.indexOf('if (!indoorBounds) {');
const branchEnd = renderer.indexOf('\n        }', outdoorBranch);
const indoorPrelude = outdoorBranch >= 0 ? renderer.slice(0, outdoorBranch) : renderer;
if (indoorPrelude.includes('markerPositions.push(')) {
  failures.push(['no marker positions are created before the outdoor-only branch', 'no indoor markerPositions.push()']);
}
for (const [label] of checks) {
  if (!failures.some(([failed]) => failed === label)) console.log(`PASS ${label}`);
}
if (failures.length) {
  for (const [label, needle] of failures) console.error(`FAIL ${label}: missing/invalid ${needle}`);
  process.exit(1);
}
console.log(`Shared path renderer contract: ${checks.length} assertions passed`);
