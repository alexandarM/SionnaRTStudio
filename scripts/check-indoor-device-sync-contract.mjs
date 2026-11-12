import fs from 'node:fs';

const runtime = fs.readFileSync('backend/indoor_scene_runtime.py', 'utf8');
const models = fs.readFileSync('backend/models.py', 'utf8');
const routes = fs.readFileSync('backend/main.py', 'utf8');
const api = fs.readFileSync('src/api.ts', 'utf8');
const panel = fs.readFileSync('src/components/SceneImportPanel.tsx', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');
const required = [
  ['runtime sync API model requires placed TX/RX devices', 'class IndoorSceneDeviceSyncRequest', models],
  ['runtime sync API model validates unique device IDs', 'Indoor {kind} device IDs must be unique', models],
  ['runtime sync API model requires canonical scene pose', 'has no scenePosition', models],
  ['PathSolver request carries current TX/RX snapshot', 'class IndoorPathSolveRequest', models],
  ['PathSolver request validates selected TX and RX membership', 'The selected TX must be included in the current placed indoor TX set.', models],
  ['runtime validates active scene ownership', 'The requested indoor scene is not the active Sionna RT scene', runtime],
  ['runtime validates common scene-level array dimensions', 'All indoor {kind} devices must use the same scene-level PlanarArray dimensions', runtime],
  ['runtime configures half-wavelength TX spacing', 'vertical_spacing=0.5, horizontal_spacing=0.5', runtime],
  ['runtime maps editor boresight to Sionna boresight', '_SIONNA_TO_CANONICAL_DEVICE_BASIS', runtime],
  ['runtime applies device-local indoor steering', 'steering_azimuth_deg=steering_azimuth', runtime],
  ['runtime constructs real Sionna transmitters and receivers', 'device_class(', runtime],
  ['device arrays are resolved against the active Scene AntennaArray class', 'AntennaArray = getattr(scene_module, \"AntennaArray\")', runtime],
  ['PlanarArray must inherit from the exact active Scene AntennaArray class', 'issubclass(PlanarArray, AntennaArray)', runtime],
  ['rollback restores an initially empty array through the backing slot', 'setattr(scene, backing_name, None)', runtime],
  ['rollback only restores array properties changed by this transaction', 'if changed:', runtime],
  ['radio devices are added one at a time using Sionna Scene.add()', 'for radio_device in (*new_tx, *new_rx):', runtime],
  ['runtime verifies registered TX and RX names', 'Sionna did not register all requested radio devices', runtime],
  ['runtime constructs TX/RX from the submitted canonical positions', 'position=tuple(float(v) for v in position)', runtime],
  ['runtime restores prior devices after a failed update', 'Indoor TX/RX rollback failed', runtime],
  ['solve route is guarded by the shared solve lock', 'with _solve_lock:', routes],
  ['PathSolver route auto-applies current request devices before tracing', 'sync_indoor_scene_devices(\n                session_id=session_id', routes],
  ['PathSolver route rejects devices belonging to another scene', 'All submitted TX/RX devices must belong to the active indoor scene', routes],
  ['legacy low-level sync endpoint remains available for diagnostics', '/devices/sync', routes],
  ['frontend sends current placed TX/RX snapshot', 'txs: indoorPlacedTxs', app],
  ['frontend sends current RF carrier frequency', 'carrierFrequencyGhz: freqGhz', app],
  ['frontend API accepts current devices rather than a stale token', 'txs: Transmitter[];', api],
  ['Scene Import describes automatic device binding', 'data-testid="indoor-auto-device-binding"', panel],
  ['Scene Import shows placed TX/RX counts', 'Placed in this scene:', panel],
  ['App keeps the device arrays and RF settings connected to Scene Import', 'applicationFrequencyGhz={freqGhz}', app],
];
const failures = required.filter(([, needle, source]) => !source.includes(needle));
if (panel.includes('Synchronize TX/RX into Sionna') || panel.includes('handleSyncDevices')) {
  failures.push(['manual sync button/handler is removed from normal user workflow', 'not present', panel]);
}
if (app.includes('Indoor TX/RX synchronization is missing or stale') || app.includes('deviceSyncToken: indoorDeviceSyncState')) {
  failures.push(['frontend no longer blocks solving on a stored sync token', 'not present', app]);
}
for (const [label] of required) {
  if (!failures.some(([failed]) => failed === label)) console.log(`PASS ${label}`);
}
if (failures.length) {
  for (const [label, needle] of failures) console.error(`FAIL ${label}: missing ${needle}`);
  process.exit(1);
}
console.log(`Indoor TX/RX automatic runtime-binding contract: ${required.length} assertions passed`);
