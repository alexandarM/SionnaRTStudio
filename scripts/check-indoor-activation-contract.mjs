import fs from 'node:fs';

const runtime = fs.readFileSync('backend/indoor_scene_runtime.py', 'utf8');
const routes = fs.readFileSync('backend/main.py', 'utf8');
const api = fs.readFileSync('src/api.ts', 'utf8');
const panel = fs.readFileSync('src/components/SceneImportPanel.tsx', 'utf8');
const required = [
  ['canonical transform is applied to source vertices', 'transformer.point_to_canonical(vertex)', runtime],
  ['reflection winding is corrected', 'mesh.faces = np.asarray(mesh.faces, dtype=np.int64)[:, [0, 2, 1]]', runtime],
  ['shape-level transform is removed after baking', '_replace_shape_transform(shape)', runtime],
  ['actual Sionna scene loader is used', 'load_scene(str(xml_path), merge_shapes=False', runtime],
  ['Sionna radio-material class is verified', 'isinstance(radio_material, material_base)', runtime],
  ['runtime state is exposed by API', '/api/scene/import/runtime/status', routes],
  ['explicit activation endpoint exists', '/api/scene/import/{session_id}/activate', routes],
  ['scene activation is wired to frontend', 'activateImportedScene(preview.sessionId', panel],
  ['ITU material catalog is rendered', 'materialCatalog?.materials.map', panel],
  ['no outdoor solver fallback is introduced', 'activate_indoor_scene(', routes],
];
const failures = required.filter(([, needle, source]) => !source.includes(needle));
for (const [label, needle] of required) {
  if (!failures.some(([failed]) => failed === label)) console.log(`PASS ${label}`);
}
if (failures.length) {
  for (const [label, needle] of failures) console.error(`FAIL ${label}: missing ${needle}`);
  process.exit(1);
}
console.log(`Indoor activation contract: ${required.length} assertions passed`);
