import fs from 'node:fs';

const main = fs.readFileSync('backend/main.py', 'utf8');
const runtime = fs.readFileSync('backend/indoor_scene_runtime.py', 'utf8');
const solver = fs.readFileSync('backend/solver.py', 'utf8');
const models = fs.readFileSync('backend/models.py', 'utf8');
const api = fs.readFileSync('src/api.ts', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');
const types = fs.readFileSync('src/types.ts', 'utf8');
const project = fs.readFileSync('src/project.ts', 'utf8');
const panel = fs.readFileSync('src/components/TrajectoryPanel.tsx', 'utf8');
const three = fs.readFileSync('src/components/ThreeStudio.tsx', 'utf8');

const runtimeStart = runtime.indexOf('def solve_indoor_mobility(');
const runtimeEnd = runtime.indexOf('\ndef _host_scalar_float', runtimeStart);
const runtimeBody = runtimeStart >= 0 && runtimeEnd > runtimeStart
  ? runtime.slice(runtimeStart, runtimeEnd)
  : '';
const solverStart = solver.indexOf('def solve_mobility(');
const solverEnd = solver.indexOf('\ndef _handover_analysis', solverStart);
const solverBody = solverStart >= 0 && solverEnd > solverStart
  ? solver.slice(solverStart, solverEnd)
  : '';
const indoorEndpointStart = main.indexOf('def api_solve_indoor_mobility(');
const indoorEndpointEnd = main.indexOf('\n@app.post(', indoorEndpointStart + 10);
const endpointBody = indoorEndpointStart >= 0 && indoorEndpointEnd > indoorEndpointStart
  ? main.slice(indoorEndpointStart, indoorEndpointEnd)
  : '';

const checks = [
  ['indoor mobility request requires placed TX devices while RX is synthesized from waypoints', models.includes('class IndoorMobilityRequest(BaseModel):') && models.includes('Indoor mobility TX IDs must be unique') && runtimeBody.includes('synthesized from the first path waypoint')],
  ['indoor mobility does not require a separately placed viewport RX', !models.includes('Indoor TX and RX devices must belong to the same imported scene session') && runtimeBody.includes('scene_rx_template')],
  ['indoor request exposes the shared transmitter interface', models.includes('def transmitters(self) -> List[Transmitter]')],
  ['dedicated endpoint is separate from the preserved outdoor /api/mobility endpoint', main.includes('/api/scene/import/{session_id}/mobility') && main.includes('@app.post("/api/mobility"')],
  ['endpoint checks selected and active scene identity', endpointBody.includes('get_selected_scene_import_session') && endpointBody.includes('get_active_indoor_scene')],
  ['endpoint returns the established MobilityResponse contract', endpointBody.includes('MobilityResponse(steps=steps, execution=execution, handover=handover)')],
  ['indoor adapter rejects stale-session devices', runtimeBody.includes('sceneSessionId') && runtimeBody.includes('active indoor scene')],
  ['indoor adapter bounds-checks scene-local waypoints', runtimeBody.includes('canonicalBounds') && runtimeBody.includes('outside the active scene bounds')],
  ['indoor adapter synthesizes RX at the first trajectory waypoint', runtimeBody.includes('sync_indoor_scene_devices(') && runtimeBody.includes('rxs=[scene_rx_template]') && runtimeBody.includes('first_waypoint')],
  ['indoor adapter routes through the shared mobility solver', runtimeBody.includes('solve_mobility(') && runtimeBody.includes('scene_override=active.scene')],
  ['indoor adapter reads TX bindings from the actual nested deviceSync response', runtimeBody.includes('binding.get(\"deviceSync\")') && runtimeBody.includes('device_sync.get(\"transmitters\")') && !runtimeBody.includes('binding[\"transmitters\"]')],
  ['shared solver preserves active Sionna TX registry and arrays', solverBody.includes('prepared_tx_names') && solverBody.includes('preserve_scene_transmitters')],
  ['batch and serial fallback paths preserve indoor TX devices', solverBody.includes('preserve_tx=preserve_scene_transmitters')],
  ['shared solver restores the viewport RX after temporary waypoint devices', solverBody.includes('saved_receivers') && solverBody.includes('_clear_receivers(scene)') && solverBody.includes('scene.add(receiver)')],
  ['outdoor mobility scene builder remains the default path', solverBody.includes('scene_override if scene_override is not None else build_scene')],
  ['frontend exposes a dedicated indoor mobility API', api.includes('solveIndoorMobility(') && api.includes('/mobility`, request)')],
  ['frontend dispatches indoors to the active scene endpoint without a manually placed RX guard', app.includes('solveIndoorMobility(indoorScene!.sessionId, request)') && app.includes('await solveMobility(') && !app.includes('Place the moving RX in the active indoor scene')],
  ['trajectory points persist their coordinate frame without invalidating old projects', types.includes("coordinateFrame?: 'outdoor_enu' | 'indoor_scene_local'") && project.includes("value.coordinateFrame === undefined")],
  ['panel shares playback, scrubber, multi-TX and A3 controls across scene modes', panel.includes('mobilityHandover.events.map') && panel.includes('btn-playback-toggle') && !panel.includes('Phase 8')],
  ['indoor loop generator respects canonical scene bounds and never falls back to outdoor ENU', panel.includes('indoorBounds.minimum') && panel.includes('if (!indoorBounds') && panel.includes("coordinateFrame: 'indoor_scene_local'") && panel.includes("coordinateFrame: 'outdoor_enu'")],
  ['3D path renderer converts indoor canonical coordinates into Three coordinates', three.includes('canonicalToThreePosition([point.enu.x, point.enu.y, point.enu.z])')],
  ['indoor floor clicks add waypoints at the configurable RX height', three.includes("classifyIndoorSurface(normal) === 'floor'") && three.includes("coordinateFrame: 'indoor_scene_local'") && three.includes('current.indoorMobilityReceiverHeight') && panel.includes('slider-indoor-rx-height')],
  ['height changes move existing waypoints and invalidate stale mobility results', app.includes('point.enu.z + delta') && app.includes('setMobilitySteps([])') && panel.includes('onIndoorReceiverHeightChange?.(Number(event.target.value))')],
  ['indoor playback has a separate moving RX marker', three.includes('indoor-mobility-rx-playback-marker')],
  ['shared indoor/outdoor trajectory speed supports 0.1 km/h with matching sampling precision', panel.includes('min="0.1"') && panel.includes('step="0.1"') && panel.includes('Number(e.target.value)') && app.includes('Math.max(speedKmh / 3.6, 1e-3)') && app.includes('Math.max(speedMs * (intervalMs / 1000), 1e-4)')],
  ['indoor and outdoor API models accept 0.1 km/h and reject lower values', models.includes('speedKmh: float = Field(default=30.0, ge=0.1, le=500.0)') && models.includes('speedKmh: float = Field(default=3.0, ge=0.1, le=500.0)')],
];

let failures = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failures += 1;
}
if (failures) process.exit(1);
console.log(`Indoor mobility contract: ${checks.length} assertions passed`);
