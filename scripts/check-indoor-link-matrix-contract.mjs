import fs from 'node:fs';

const main = fs.readFileSync('backend/main.py', 'utf8');
const runtime = fs.readFileSync('backend/indoor_scene_runtime.py', 'utf8');
const models = fs.readFileSync('backend/models.py', 'utf8');
const api = fs.readFileSync('src/api.ts', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');
const panel = fs.readFileSync('src/components/LinkPanel.tsx', 'utf8');

const functionStart = runtime.indexOf('def solve_indoor_link_matrix(');
const functionEnd = runtime.indexOf('\ndef deactivate_indoor_scene', functionStart);
const matrixRuntime = functionStart >= 0 && functionEnd > functionStart
  ? runtime.slice(functionStart, functionEnd)
  : '';

const checks = [
  ['dedicated indoor matrix request model is defined', models.includes('class IndoorPathMatrixSolveRequest(BaseModel):')],
  ['indoor matrix endpoint is registered', main.includes('/path-solve-matrix')],
  ['endpoint applies the full device snapshot once', main.includes('sync_indoor_scene_devices(') && main.includes('return solve_indoor_link_matrix(')],
  ['matrix runtime calls the shared PathSolver adapter', matrixRuntime.includes('_trace_paths(scene, int(max_depth), solver_options)')],
  ['matrix runtime dispatches PathSolver exactly once', (matrixRuntime.match(/_trace_paths\(/g) ?? []).length === 1],
  ['matrix runtime iterates all Tx and Rx records', matrixRuntime.includes('for tx_record in tx_records:') && matrixRuntime.includes('for rx_record in rx_records:')],
  ['matrix pairs use shared outdoor path and KPI builders', matrixRuntime.includes('_build_paths(') && matrixRuntime.includes('_channel_metrics(')],
  ['frontend API targets indoor path-solve-matrix endpoint', api.includes('/path-solve-matrix') && api.includes('solveIndoorPathMatrix(')],
  ['frontend fills every Tx×Rx matrix cell from returned pairs', app.includes('solveIndoorPathMatrix(indoorScene.sessionId') && app.includes('for (const pair of response.pairs)')],
  ['indoor matrix experiment replay uses its own endpoint', app.includes("replay.endpoint.includes('/path-solve-matrix')")],
  ['indoor matrix button is no longer disabled by indoor mode', !/disabled=\{matrixLoading \|\| !backendOnline \|\| indoorMode\}/.test(panel)],
  ['outdoor per-pair matrix path is retained', app.includes('await solveLink(t, r, buildings, freqGhz, maxDepth, solverOptions, materialList)')],
];

let failures = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failures += 1;
}
if (failures) process.exit(1);
console.log(`Indoor link-matrix contract: ${checks.length} assertions passed`);
