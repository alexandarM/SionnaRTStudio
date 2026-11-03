import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const field = fs.readFileSync(new URL('../src/components/FieldValidationPanel.tsx', import.meta.url), 'utf8');
const analysis = fs.readFileSync(new URL('../src/components/AnalysisPanel.tsx', import.meta.url), 'utf8');
const trajectory = fs.readFileSync(new URL('../src/components/TrajectoryPanel.tsx', import.meta.url), 'utf8');
const mapSelector = fs.readFileSync(new URL('../src/components/MapSelector.tsx', import.meta.url), 'utf8');

// Panels that carry local state/results are rendered continuously and hidden
// rather than conditionally removed from the React tree.
for (const mode of ['link', 'heatmap', 'playback']) {
  assert.match(app, new RegExp(`<div className=\\{activeMode === '${mode}' \\? 'contents' : 'hidden'\\}>`),
    `${mode} mode must remain mounted while another mode is active`);
}
for (const tab of ['geography', 'analysis', 'field_validation', 'export']) {
  assert.match(app, new RegExp(`<div className=\\{activeNavTab === '${tab}' \\? 'contents' : 'hidden'\\}>`),
    `${tab} workspace must remain mounted while another tab is active`);
}
assert.doesNotMatch(app, /\{activeMode === '(?:link|heatmap|playback)' && \(/,
  'Mode panels must not use conditional unmounting');
assert.doesNotMatch(app, /\{activeNavTab === '(?:geography|analysis|field_validation|export)' && \(/,
  'Workspace panels must not use conditional unmounting');

// Analysis owns the background NR PHY job status polling. Because the panel is
// kept mounted, changing tabs must not run this effect's cancellation cleanup.
assert.match(analysis, /useEffect\(\(\) => \{\s*if \(!phyJobId\) return;/,
  'Analysis must retain its job polling effect');
assert.match(analysis, /return \(\) => \{\s*cancelled = true;[\s\S]*?clearTimeout\(timer\)/,
  'PHY polling cleanup must remain tied to job-id lifecycle, not tab navigation');

// Field Validation must load its backend dataset list after health is available,
// since it now mounts before the user opens the tab.
assert.match(field, /if \(backendOnline\) void refreshDatasets\(\);/,
  'Field Validation should initialize when backend becomes online');
assert.match(field, /await refreshDatasets\(imported\.datasetId, false\);/,
  'CSV import must not release its busy state through a nested refresh');

// A preserved trajectory panel must stop its playback timer when hidden.
assert.match(trajectory, /if \(!active\) stopMobilityPlayback\(\);/,
  'Trajectory playback must pause while its panel is hidden');

// OSM controls must be re-enabled on every exit path, including early returns.
const osmHandler = app.match(/const handleDownloadOSM = async \(bounds: L\.LatLngBounds\) => \{([\s\S]*?)\n  \};/);
assert.ok(osmHandler, 'OSM download handler exists');
assert.match(osmHandler[1], /finally\s*\{[\s\S]*?setGisLoading\(false\);/,
  'OSM loading state must always be released in finally');
assert.doesNotMatch(osmHandler[1], /setTimeout\(\(\) => setGisLoading\(false\)/,
  'OSM loading state must not depend on delayed timers');
assert.match(mapSelector, /\(isLoading \|\| downloadProgress\) && \(/,
  'OSM result feedback must remain visible after loading finishes');
assert.match(mapSelector, /disabled=\{isLoading\}/,
  'OSM controls must only be disabled while a request is in flight');

console.log('Panel lifecycle checks passed: workspace/mode retention, PHY polling owner, field validation state, playback pause, OSM unlock and feedback.');
