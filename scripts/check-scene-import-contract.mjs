import fs from 'node:fs';
import path from 'node:path';

const read = (relative) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
const checks = [
  ['Scene Import navigation tab', read('src/components/TopNav.tsx').includes("['Scene Import', 'scene_import']")],
  ['Scene importer UI wired to preview API', read('src/components/SceneImportPanel.tsx').includes('previewImportedScene(file, profile)')],
  ['Preview remount uses a typed sessionId prop (not JSX key)', read('src/components/SceneImportPanel.tsx').includes('function ImportPreview3D({ url, sessionId }: { url: string; sessionId: string })') && read('src/components/SceneImportPanel.tsx').includes('<ImportPreview3D sessionId={preview.sessionId} url={preview.previewUrl} />') && !read('src/components/SceneImportPanel.tsx').includes('<ImportPreview3D key={preview.sessionId}')],
  ['Scene importer requires explicit source axes', read('src/components/SceneImportPanel.tsx').includes('Select the source up axis, forward axis, units and handedness')],
  ['Scene importer clearly marks preview as non-activating', read('src/components/SceneImportPanel.tsx').includes('Not loaded into Sionna RT')],
  ['Preview material inventory exposes Mitsuba-derived appearance', read('src/components/SceneImportPanel.tsx').includes('Preview appearance') && read('src/api.ts').includes('previewColorLinear')],
  ['Scene importer resolves BSDF appearance and bitmap textures', read('backend/scene_import.py').includes('_resolve_bsdf_visual') && read('backend/scene_import.py').includes('baseColorTexture=image') && !read('backend/scene_import.py').includes('PREVIEW_PALETTE')],
  ['Backend raw ZIP preview endpoint', read('backend/main.py').includes('@app.post("/api/scene/import/preview")')],
  ['Backend GLB preview endpoint', read('backend/main.py').includes('@app.get("/api/scene/import/{session_id}/preview.glb")')],
  ['Backend staged-session delete endpoint', read('backend/main.py').includes('@app.delete("/api/scene/import/{session_id}")')],
  ['Secure archive validator', read('backend/scene_import.py').includes('MAX_UNCOMPRESSED_BYTES') && read('backend/scene_import.py').includes('Symbolic links are not allowed')],
  ['Canonical coordinate transform is applied to preview vertices', read('backend/scene_import.py').includes('transformer.point_to_canonical(row)')],
];
let failed = false;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log(`Scene import contract: ${checks.length}/${checks.length} PASS`);
