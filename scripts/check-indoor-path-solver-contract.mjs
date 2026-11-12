import fs from 'node:fs';

const runtime = fs.readFileSync('backend/indoor_scene_runtime.py', 'utf8');
const models = fs.readFileSync('backend/models.py', 'utf8');
const routes = fs.readFileSync('backend/main.py', 'utf8');
const api = fs.readFileSync('src/api.ts', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');
const panel = fs.readFileSync('src/components/LinkPanel.tsx', 'utf8');
const scenePanel = fs.readFileSync('src/components/SceneImportPanel.tsx', 'utf8');
const required = [
  ['indoor PathSolver request carries current placed TX/RX state', 'txs: List[Transmitter] = Field(min_length=1, max_length=128)', models],
  ['indoor PathSolver request validates selected pair is in submitted devices', 'The selected TX must be included in the current placed indoor TX set.', models],
  ['request bounds PathSolver max depth', 'maxDepth: int = Field(default=3, ge=0, le=20)', models],
  ['PathSolver auto-registers latest viewport TX/RX immediately before tracing', 'sync_indoor_scene_devices(\n                session_id=session_id', routes],
  ['PathSolver looks up the selected real Sionna TX/RX objects', 'tx_runtime = tx_registry.get(tx_name)', runtime],
  ['PathSolver uses the active scene rather than rebuilding outdoor geometry', '_trace_paths(scene, int(max_depth), solver_options)', runtime],
  ['PathSolver explicitly converts tensors to numpy-compatible arrays', 'def _path_array_view', runtime],
  ['Dr.Jit scalar conversion remains available for safe rollback snapshots', 'numpy_method() if callable(numpy_method) else value', runtime],
  ['automatic device binding reads the previous Mitsuba frequency through the Dr.Jit bridge', 'old_frequency = _host_scalar_float(', runtime],
  ['PathSolver preserves physical Rx/Tx antenna axes for channel coefficients', 'a_coefficients[rx_index, :, tx_index, :, :]', runtime],
  ['PathSolver converts paths to the app path model', '_build_paths(', runtime],
  ['PathSolver computes KPIs over the returned path set', '_channel_metrics(full_paths)', runtime],
  ['PathSolver returns native and normalized tensor dimensions for diagnostics', '"nativeTensorShapes": native_tensor_shapes', runtime],
  ['PathSolver returns normalized tensor dimensions for pair extraction', '"normalizedTensorShapes": tensor_shapes', runtime],
  ['PathSolver reports active scene object and material counts', '"sceneObjectCount": int(active.summary.get("registeredObjectCount"', runtime],
  ['no-path completion is explicitly distinguished', 'completed_no_paths', runtime],
  ['indoor endpoint is separate from outdoor /api/solve', '@app.post("/api/scene/import/{session_id}/path-solve")', routes],
  ['endpoint serializes the GPU solver under solve lock', 'with _solve_lock:', routes],
  ['endpoint fails closed unless selected and active scene match', 'Select this indoor scene in the Scene Manager before running PathSolver', routes],
  ['frontend exposes dedicated indoor PathSolver API', '/path-solve', api],
  ['frontend refuses unplaced or cross-session TX/RX', 'Place the selected TX and RX in the active indoor scene', app],
  ['frontend submits current viewport devices with indoor PathSolver request', 'txs: indoorPlacedTxs', app],
  ['existing Link Analysis invokes indoor PathSolver for indoor scenes', 'await solveIndoorPath(indoorScene.sessionId', app],
  ['frontend validates indoor response with a typed runtime guard', 'isIndoorPathSolveResponse(res)', app],
  ['indoor API exposes a runtime type guard for execution metadata', 'export function isIndoorPathSolveResponse', api],
  ['PathSolver execution and no-path state are visible to user', 'path-solver-execution-status', panel],
  ['indoor solve does not gate dispatch on redundant PlanarArray row/column introspection', 'Do not introspect undocumented dimensions', runtime],
  ['indoor all-pairs action is enabled in the shared Link Matrix panel', 'Solve All Indoor Pairs · Sionna RT', panel],
  ['indoor Link Matrix is dispatched through the dedicated matrix API', 'solveIndoorPathMatrix(indoorScene.sessionId', app],
  ['Scene Import explains automatic TX/RX runtime binding', 'data-testid=\"indoor-auto-device-binding\"', scenePanel],
];
const failures = required.filter(([, needle, source]) => !source.includes(needle));
if (app.includes('Indoor TX/RX synchronization is missing or stale')) failures.push(['obsolete frontend sync-token guard', 'not present', app]);
if (scenePanel.includes('Synchronize TX/RX into Sionna') || scenePanel.includes('handleSyncDevices')) failures.push(['manual sync button/handler must be removed from the user workflow', 'not present', scenePanel]);
for (const [label] of required) {
  if (!failures.some(([failed]) => failed === label)) console.log(`PASS ${label}`);
}
if (failures.length) {
  for (const [label, needle] of failures) console.error(`FAIL ${label}: missing ${needle}`);
  process.exit(1);
}
console.log(`Indoor PathSolver integration contract: ${required.length} assertions passed`);
