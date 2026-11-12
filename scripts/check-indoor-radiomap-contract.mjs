import fs from 'node:fs';

const main = fs.readFileSync('backend/main.py', 'utf8');
const runtime = fs.readFileSync('backend/indoor_scene_runtime.py', 'utf8');
const solver = fs.readFileSync('backend/solver.py', 'utf8');
const models = fs.readFileSync('backend/models.py', 'utf8');
const api = fs.readFileSync('src/api.ts', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');
const panel = fs.readFileSync('src/components/CoveragePanel.tsx', 'utf8');
const assoc = fs.readFileSync('src/components/CellAssociationMap.tsx', 'utf8');
const three = fs.readFileSync('src/components/ThreeStudio.tsx', 'utf8');

const configureStart = runtime.indexOf('def configure_indoor_scene_transmitters_for_radiomap(');
const solveStart = runtime.indexOf('def solve_indoor_radiomap(');
const solveEnd = runtime.indexOf('\ndef _host_scalar_float', solveStart);
const configureBody = configureStart >= 0 && solveStart > configureStart ? runtime.slice(configureStart, solveStart) : '';
const solveBody = solveStart >= 0 && solveEnd > solveStart ? runtime.slice(solveStart, solveEnd) : '';
const sharedSolverStart = solver.indexOf('def solve_radiomap(');
const sharedSolverEnd = solver.indexOf('\ndef ', sharedSolverStart + 5);
const sharedSolverBody = sharedSolverStart >= 0 ? solver.slice(sharedSolverStart, sharedSolverEnd > sharedSolverStart ? sharedSolverEnd : undefined) : '';

const checks = [
  ['indoor radio-map request requires scene-local TX poses', models.includes('class IndoorRadioMapRequest(RadioMapRequest):') && models.includes('sceneSessionId')],
  ['indoor endpoint is separate from the preserved outdoor /api/radiomap route', main.includes('/api/scene/import/{session_id}/radiomap') && main.includes('@app.post("/api/radiomap"')],
  ['TX-only binding does not require a viewport RX', configureBody.includes('if not txs:') && !configureBody.includes('if not txs or not rxs')],
  ['binding reuses the active scene and adds each TX individually', configureBody.includes('scene = active.scene') && configureBody.includes('scene.add(radio_device)')],
  ['indoor solve reuses the already active scene', solveBody.includes('scene_override=active.scene') && solveBody.includes('devices_prepared=True')],
  ['indoor solve uses canonical scene bounds and local grid height', solveBody.includes('canonicalBounds') && solveBody.includes('map_height_z=map_z')],
  ['shared RadioMapSolver supports a scene override', sharedSolverBody.includes('scene_override') && sharedSolverBody.includes('RadioMapSolver()')],
  ['outdoor build_scene path remains the default', sharedSolverBody.includes('scene_override if scene_override is not None else build_scene')],
  ['frontend calls the dedicated indoor radio-map endpoint', api.includes('solveIndoorRadioMap(') && api.includes('/radiomap`')],
  ['coverage solve branches between indoor adapter and original outdoor API', app.includes('solveIndoorRadioMap(') && app.includes('solveRadioMap(') && app.includes('indoorCoverageTxs')],
  ['indoor map never adds WGS84 georeference', app.includes('geoReference: null')],
  ['indoor controls use fine room-scale height and cell-size ranges', panel.includes('indoorMaxHeight') && panel.includes("indoorMode ? 0.1 : 3")],
  ['indoor exports use scene-local coordinate headings', panel.includes('x_scene_local_m') && panel.includes('canonical indoor scene-local metres')],
  ['indoor radio-map TX metadata uses scene-local rather than ENU coordinate naming', solver.includes('positionSceneLocalM') && solver.includes('positionM') && solver.includes('canonical_scene_local')],
  ['indoor coverage action is disabled with a clear prompt until a scene-bound TX is placed', panel.includes('indoorMode && txCount === 0') && panel.includes('Place an indoor TX first') && panel.includes('No indoor TX')],
  ['cell association view uses indoor TX scenePosition and local axes', assoc.includes('tx.scenePosition?.[0]') && assoc.includes("'Scene X' : 'East'")],
  ['3D radio map plane follows indoor cell Z', three.includes('current.indoorScene ? cell.z : 0.2')],
  ['per-cell channel analysis is now shared by indoor and outdoor coverage modes', panel.includes('{radioMap?.mapId && (') && panel.includes('<ChannelAnalysisPanel') && panel.includes('indoorMode={indoorMode}') && !panel.includes('Per-cell CIR/CFR PathSolver analysis is not enabled')],
];

let failures = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failures += 1;
}
if (failures) process.exit(1);
console.log(`Indoor RadioMapSolver contract: ${checks.length} assertions passed`);
