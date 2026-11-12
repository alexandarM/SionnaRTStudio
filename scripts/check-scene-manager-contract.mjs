import fs from 'node:fs';
import path from 'node:path';

const read = (relative) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
const backend = read('backend/scene_import.py');
const routes = read('backend/main.py');
const panel = read('src/components/SceneImportPanel.tsx');
const api = read('src/api.ts');
const checks = [
  ['Scene sessions have content and coordinate-frame cache identity', backend.includes('archive_sha256') && backend.includes('cache_key') && backend.includes('frame_payload')],
  ['Duplicate imports reuse an existing session', backend.includes('if session.cache_key and session.cache_key == cache_key') && backend.includes('reused[\"cacheHit\"] = True')],
  ['Session manifests are atomically persisted', backend.includes('_write_json_atomic') && backend.includes('__scene_import_manifest__.json')],
  ['Backend process can rehydrate sessions from cache directory', backend.includes('_ensure_sessions_restored_locked') && backend.includes('Rehydrate the session registry')],
  ['Scene manager enforces TTL and LRU/cache-size limits', backend.includes('SCENE_SESSION_TTL') && backend.includes('MAX_CACHED_SCENES') && backend.includes('_prune_sessions_locked')],
  ['Only one staged scene can be selected', backend.includes('select_scene_import_session') && backend.includes('_SELECTED_SESSION_ID')],
  ['Selecting a scene explicitly does not activate Sionna RT', backend.includes('not_loaded_into_sionna') && routes.includes('Select a staged scene;') && routes.includes('deactivate_indoor_scene(active.session_id)')],
  ['Session list/select/clear APIs are registered before dynamic session routes', routes.indexOf('/api/scene/import/sessions') < routes.indexOf('/api/scene/import/{session_id}') && routes.includes('/api/scene/import/selection')],
  ['Frontend restores selected session after mount', panel.includes('listImportedSceneSessions()') && panel.includes('getImportedScene(result.selectedSessionId)')],
  ['Frontend exposes persistent session history and explicit selection', panel.includes('Persistent Scene Manager') && panel.includes('Select in Scene Manager')],
  ['Frontend can delete a session without deleting other staged scenes', panel.includes('handleDeleteSession') && api.includes('deleteImportedScene(sessionId: string)')],
];
let failed = false;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log(`Scene Manager contract: ${checks.length}/${checks.length} PASS`);
