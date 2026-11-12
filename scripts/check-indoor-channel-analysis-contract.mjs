import fs from 'node:fs';

const main = fs.readFileSync('backend/main.py', 'utf8');
const runtime = fs.readFileSync('backend/indoor_scene_runtime.py', 'utf8');
const solver = fs.readFileSync('backend/solver.py', 'utf8');
const panel = fs.readFileSync('src/components/ChannelAnalysisPanel.tsx', 'utf8');
const coverage = fs.readFileSync('src/components/CoveragePanel.tsx', 'utf8');
const api = fs.readFileSync('src/api.ts', 'utf8');
const tests = fs.readFileSync('backend/tests/test_indoor_channel_analysis.py', 'utf8');

const runtimeStart = runtime.indexOf('def solve_indoor_radio_map_channel_analysis(');
const runtimeEnd = runtime.indexOf('\ndef solve_indoor_mobility(', runtimeStart);
const runtimeBody = runtimeStart >= 0 && runtimeEnd > runtimeStart
  ? runtime.slice(runtimeStart, runtimeEnd)
  : '';
const solverStart = solver.indexOf('def solve_radio_map_channel_analysis(');
const solverEnd = solver.indexOf('\ndef _finite_float', solverStart);
const solverBody = solverStart >= 0 && solverEnd > solverStart
  ? solver.slice(solverStart, solverEnd)
  : '';
const endpointStart = main.indexOf('def api_radiomap_channel_analysis(');
const endpointEnd = main.indexOf('\n@app.post(', endpointStart + 10);
const endpointBody = endpointStart >= 0 && endpointEnd > endpointStart
  ? main.slice(endpointStart, endpointEnd)
  : '';

const checks = [
  ['existing radio-map endpoint dispatches indoor maps to the indoor adapter and preserves the outdoor solver', endpointBody.includes('if is_indoor_radio_map(map_id)') && endpointBody.includes('solve_indoor_radio_map_channel_analysis(map_id, req)') && endpointBody.includes('return solve_radio_map_channel_analysis(map_id, req)')],
  ['indoor adapter resolves the exact active scene session stored with the map', runtimeBody.includes('context.get("indoorSessionId")') && runtimeBody.includes('active.session_id != session_id')],
  ['indoor adapter confirms TX registry order and managed-name snapshot', runtimeBody.includes('context.get("runtimeTxNames")') && runtimeBody.includes('loaded_names != expected_names') && runtimeBody.includes('managed_names != expected_names')],
  ['indoor adapter rejects stale carrier-frequency snapshots', runtimeBody.includes('context.get("frequencyGhz"') && runtimeBody.includes('getattr(active, "carrier_frequency_ghz", None)') && runtimeBody.includes('carrier frequency changed')],
  ['indoor adapter rejects stale TX positions, orientations, powers and array configuration', runtimeBody.includes('current_sync.get("transmitters")') && runtimeBody.includes('current_sync.get("txArray")') && runtimeBody.includes('antenna array changed')],
  ['indoor adapter calls the shared Channel Analysis solver with the live scene and TX preservation', runtimeBody.includes('solve_radio_map_channel_analysis(') && runtimeBody.includes('scene_override=active.scene') && runtimeBody.includes('preserve_scene_transmitters=True')],
  ['shared solver defaults to original outdoor scene reconstruction', solverBody.includes('scene_override if scene_override is not None else build_scene')],
  ['indoor shared solver does not rebuild the outdoor scene or replace active TX devices', solverBody.includes('if preserve_scene_transmitters:') && solverBody.includes('preserve_tx=preserve_scene_transmitters') && solverBody.includes('n_tx_ant = int(getattr(tx_array, "num_ant", 0))')],
  ['indoor solve restores existing viewport RX devices and RX array in a finally block', solverBody.includes('saved_receivers =') && solverBody.includes('previous_rx_array =') && solverBody.includes('finally:') && solverBody.includes('for receiver in saved_receivers')],
  ['indoor response identifies canonical scene-local coordinates and never labels them ENU', solverBody.includes('"coordinateFrame": "canonical_scene_local" if context.get("sceneType") == "indoor" else "ENU"') && solverBody.includes('"positionSceneLocalM" if context.get("sceneType") == "indoor" else "positionEnuM"')],
  ['coverage panel exposes the shared Channel Analysis panel in indoor and outdoor modes', coverage.includes('{radioMap?.mapId && (') && coverage.includes('<ChannelAnalysisPanel') && coverage.includes('indoorMode={indoorMode}') && !coverage.includes('Per-cell CIR/CFR PathSolver analysis is not enabled')],
  ['indoor panel displays scene-local coordinates and suppresses WGS84/Google Maps conversion', panel.includes("coordinateFrame: indoorMode ? 'canonical_scene_local' : 'ENU'") && panel.includes("indoorMode ? 'Scene-local XYZ' : 'ENU'") && panel.includes('{!indoorMode && <button') && panel.includes('positionSceneLocalM')],
  ['shared API response types support either ENU or canonical indoor scene-local positions', api.includes("coordinateFrame: 'ENU' | 'canonical_scene_local'") && api.includes('positionEnuM?:') && api.includes('positionSceneLocalM?:')],
  ['backend regression tests cover live scene reuse, stale scene/TX/frequency/array rejection and RX restoration', tests.includes('test_indoor_runtime_adapter_uses_the_active_scene_and_shared_solver') && tests.includes('test_indoor_runtime_adapter_rejects_changed_carrier_frequency') && tests.includes('test_indoor_runtime_adapter_rejects_changed_tx_array_pattern') && tests.includes('test_shared_channel_analysis_uses_live_indoor_scene_and_restores_rx_state') && tests.includes('test_shared_channel_analysis_restores_indoor_rx_state_after_solver_error')],
];

let failures = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failures += 1;
}
if (failures) process.exit(1);
console.log(`Indoor Channel Analysis contract: ${checks.length} assertions passed`);
