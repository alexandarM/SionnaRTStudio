import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const threeStudio = await readFile(new URL('../src/components/ThreeStudio.tsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const types = await readFile(new URL('../src/types.ts', import.meta.url), 'utf8');
const solverControls = await readFile(new URL('../src/components/SolverControls.tsx', import.meta.url), 'utf8');
const trajectoryPanel = await readFile(new URL('../src/components/TrajectoryPanel.tsx', import.meta.url), 'utf8');

assert.match(threeStudio, /from 'three\/addons\/controls\/TransformControls\.js'/, 'TransformControls must be used for indoor gizmo interaction');
assert.match(threeStudio, /from 'three\/addons\/loaders\/GLTFLoader\.js'/, 'The staged scene GLB must be loaded into the shared viewport');
assert.match(threeStudio, /raycaster\.intersectObjects\(indoorPickMeshes, true\)/, 'Indoor placement must raycast actual imported scene meshes');
assert.match(threeStudio, /normalThree\.dot\(raycaster\.ray\.direction\) > 0/, 'Surface normals must be oriented toward the clicked side');
assert.match(threeStudio, /surfaceNormalToCanonicalQuaternion\(normalThree\)/, 'Device orientation must follow the selected surface normal');
assert.match(threeStudio, /deviceTransformControls\.attach\(selectedRoot\)/, 'Selected indoor device must expose a transform gizmo');
assert.match(threeStudio, /deviceTransformControls\.addEventListener\('mouseUp'/, 'Device transforms must be committed after gizmo interaction');
assert.match(threeStudio, /sceneSessionId: current\.indoorScene\.sessionId/, 'Device pose must be tied to the selected scene session');
assert.match(threeStudio, /if \(current\.indoorScene\) \{[\s\S]*?return;\s*\}\s*\/\/ Outdoor path remains unchanged/, 'Indoor raycast handling must finish before outdoor ENU placement logic');
assert.match(threeStudio, /const indoorStaticGroup = new THREE\.Group\(\)/, 'Indoor geometry must remain in a separate static scene group');
assert.match(threeStudio, /indoorScene\?\.sessionId, indoorScene\?\.previewUrl/, 'Static renderer lifecycle must depend on scene identity, not device movement');
assert.match(app, /scenePosition: undefined[\s\S]*?sceneSessionId: indoorScene\.sessionId/, 'New indoor devices must start unplaced but belong to the selected session');
assert.match(app, /if \(indoorScene && \(!updatedTx\.sceneSessionId \|\| updatedTx\.sceneSessionId === indoorScene\.sessionId\)\) \{[\s\S]*?return;/, 'Indoor TX updates must remain scene-local and must not be converted to ENU/GPS');
assert.match(app, /if \(indoorScene && \(!updatedRx\.sceneSessionId \|\| updatedRx\.sceneSessionId === indoorScene\.sessionId\)\) \{[\s\S]*?return;/, 'Indoor RX updates must remain scene-local and must not be converted to ENU/GPS');
assert.match(types, /export interface IndoorDevicePlacement[\s\S]*?scenePosition\?: SceneLocalVector3[\s\S]*?sceneOrientation\?: SceneLocalQuaternion/, 'Indoor device pose must be explicitly typed separately from ENU');
assert.match(solverControls, /indoorMode\?: boolean/, 'Shared RF controls must know the active scene mode');
assert.match(solverControls, /!indoorMode \?/ , 'Outdoor tower/AGL height controls must not be presented as indoor placement controls');
assert.match(trajectoryPanel, /Indoor trajectory support — Phase 8/, 'Trajectory panel must remain visible with an explicit indoor Phase 8 status');
assert.match(trajectoryPanel, /Indoor transmitter inventory/, 'Trajectory panel must retain indoor TX inventory management');
assert.match(app, /indoorMode=\{Boolean\(indoorScene\)\}/g, 'Indoor mode must be routed into shared device/RF panels');

console.log('Indoor placement integration contract: PASS (shared viewport, scene raycast, surface pose, transform gizmo, scene-local device state, outdoor branch retained, height controls adapted, trajectory panel preserved)');
