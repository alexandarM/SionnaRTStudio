// Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
// Upstream: https://github.com/puloktarafder/SionnaRTStudio

import assert from 'node:assert/strict';
import {
  buildOsmOverpassQuery,
  fetchOSMBuildings,
  mergeOverpassResponses,
  parseOsmElements,
  splitOsmBounds,
  OSM_OVERPASS_ENDPOINTS,
  OSM_QUERY_TIMEOUT_SECONDS,
  OSM_TILE_SIZE_METERS,
  type OverpassData,
} from '../src/utils.ts';

const bounds = { south: 38.9, west: -77.1, north: 39.0, east: -77.0 };
const anchor = { latitude: 38.95, longitude: -77.05 };
const data: OverpassData = {
  elements: [
    { type: 'node', id: 1, lat: 38.94, lon: -77.04 },
    { type: 'node', id: 2, lat: 38.94, lon: -77.03 },
    { type: 'node', id: 3, lat: 38.95, lon: -77.03 },
    { type: 'node', id: 4, lat: 38.94, lon: -77.04 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 4], tags: {
      building: 'school', height: 'not-a-number', 'building:levels': '2', material: 'brick',
    } },
    { type: 'node', id: 20, lat: 38.89, lon: -77.11 },
    { type: 'node', id: 21, lat: 39.01, lon: -76.99 },
    { type: 'way', id: 11, nodes: [20, 21], tags: { highway: 'primary', name: 'Georgia Avenue NW' } },
    { type: 'node', id: 30, lat: 38.96, lon: -77.06 },
    { type: 'node', id: 31, lat: 38.96, lon: -77.05 },
    { type: 'node', id: 32, lat: 38.97, lon: -77.05 },
    { type: 'way', id: 99, nodes: [30, 31, 32, 30] },
    { type: 'relation', id: 12, tags: { building: 'office', material: 'glass' }, members: [
      { type: 'way', ref: 99, role: 'outer' },
    ] },
  ],
};

const first = parseOsmElements(data, bounds, anchor);
const second = parseOsmElements(data, bounds, anchor);
assert.deepEqual(first, second, 'production parser must be deterministic');
assert.equal(first.length, 3);

const school = first.find((feature) => feature.id === 'osm_10');
assert.equal(school?.height, 7);
assert.equal(school?.material, 'itu_brick');
assert.equal(school?.levels, 2);

const road = first.find((feature) => feature.id === 'osm_11');
assert.equal(road?.category, 'infrastructure');
assert.equal(road?.name, 'Georgia Avenue NW');
assert.deepEqual(road?.points, [
  { lat: bounds.south, lon: bounds.west },
  { lat: bounds.north, lon: bounds.east },
]);

const relation = first.find((feature) => feature.id === 'osm_rel_12_0');
assert.equal(relation?.category, 'building');
assert.equal(relation?.material, 'itu_glass');
assert.equal(relation?.points.length, 4);

// A 5 km × 5 km selection must be tiled rather than rejected at the former
// 2 km UI maximum. Every tile remains within the Overpass request-size target.
const cityBounds = {
  south: 38.9274,
  west: -77.0489,
  north: 38.9726,
  east: -76.9991,
};
const cityTiles = splitOsmBounds(cityBounds);
assert.ok(cityTiles.length > 1, 'large OSM selections must be split into tiles');
const totalTileArea = cityTiles.reduce(
  (sum, tile) => sum + (tile.north - tile.south) * (tile.east - tile.west),
  0,
);
const requestedArea = (cityBounds.north - cityBounds.south) * (cityBounds.east - cityBounds.west);
assert.ok(Math.abs(totalTileArea - requestedArea) < requestedArea * 1e-9, 'tiles must cover the selection without gaps or overlaps');
cityTiles.forEach((tile) => {
  const latSizeMeters = (tile.north - tile.south) * 110_574;
  const meanLat = (tile.north + tile.south) / 2;
  const lonSizeMeters = (tile.east - tile.west) * 111_320 * Math.cos((meanLat * Math.PI) / 180);
  assert.ok(latSizeMeters <= OSM_TILE_SIZE_METERS + 1e-6, 'tile latitude span must stay within target');
  assert.ok(lonSizeMeters <= OSM_TILE_SIZE_METERS + 1e-6, 'tile longitude span must stay within target');
});

// Elements returned in adjacent Overpass tiles must be deduplicated by type/id
// while retaining the richest node/member arrays needed to rebuild relations.
const merged = mergeOverpassResponses([
  { elements: [
    { type: 'node', id: 1, lat: 38.94, lon: -77.04 },
    { type: 'way', id: 10, nodes: [1, 2], tags: { building: 'yes' } },
    { type: 'relation', id: 50, members: [{ type: 'way', ref: 10, role: 'outer' }] },
  ] },
  { elements: [
    { type: 'node', id: 1, lat: 38.94, lon: -77.04 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 1], tags: { height: '12' } },
    { type: 'relation', id: 50, members: [{ type: 'way', ref: 11, role: 'outer' }] },
    { type: 'node', id: 3, lat: 38.95, lon: -77.03 },
  ] },
]);
assert.equal(merged.elements?.length, 4, 'duplicate OSM elements must be merged');
const mergedWay = merged.elements?.find((element) => element.type === 'way' && element.id === 10);
assert.deepEqual(mergedWay?.nodes, [1, 2, 3, 1], 'longest way geometry must be retained');
assert.deepEqual(mergedWay?.tags, { building: 'yes', height: '12' }, 'tags from tiled responses must be combined');
const mergedRelation = merged.elements?.find((element) => element.type === 'relation' && element.id === 50);
assert.deepEqual(mergedRelation?.members, [
  { type: 'way', ref: 10, role: 'outer' },
  { type: 'way', ref: 11, role: 'outer' },
], 'relation members from adjacent tile responses must be unioned');


// Runtime endpoint regression: browser fetches go through the same-origin
// FastAPI proxy, which has three documented global providers and avoids browser
// CORS / missing User-Agent issues.
assert.ok(OSM_OVERPASS_ENDPOINTS.includes('https://maps.mail.ru/osm/tools/overpass/api/interpreter'));
assert.ok(OSM_OVERPASS_ENDPOINTS.includes('https://overpass.private.coffee/api/interpreter'));
assert.ok(OSM_OVERPASS_ENDPOINTS.includes('https://overpass-api.de/api/interpreter'));
assert.ok(OSM_OVERPASS_ENDPOINTS.every((endpoint) => !endpoint.includes('z.overpass-api.de')));
assert.equal(OSM_QUERY_TIMEOUT_SECONDS, 45);
assert.equal(OSM_TILE_SIZE_METERS, 2_500);
const query = buildOsmOverpassQuery(cityBounds);
assert.match(query, /^\[out:json\]\[timeout:45\];/);
assert.match(query, /relation\["building"\]/);

async function runOverpassResilienceFixtures(): Promise<void> {
  // Browser-to-backend contract: the frontend makes a same-origin JSON request
  // and never calls a public Overpass domain directly.
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (ms === 15_000 || ms === 30_000) {
      queueMicrotask(() => callback(...args));
      return 0;
    }
    return originalSetTimeout(callback as TimerHandler, ms, ...args);
  };

  const testBounds = { south: 38.95, west: -77.05, north: 38.953, east: -77.046 };
  const testAnchor = { latitude: 38.9515, longitude: -77.048 };
  const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  try {
    let requests: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ elements: [], source: 'maps.mail.ru' });
    };
    const successFeatures = await fetchOSMBuildings(
      testBounds.south, testBounds.west, testBounds.north, testBounds.east, testAnchor,
    );
    assert.deepEqual(successFeatures, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/osm/query');
    assert.equal(requests[0].init?.method, 'POST');
    assert.match(String(requests[0].init?.headers && (requests[0].init?.headers as Record<string, string>)['Content-Type']), /application\/json/);

    // HTTP 503 from all upstream providers is a capacity problem, not evidence
    // that this tile is too large: wait once and retry the SAME tile, without
    // generating four more smaller public requests.
    requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ detail: { message: 'All Overpass instances are busy', kind: 'capacity' } }, 503);
    };
    let capacityError = '';
    try {
      await fetchOSMBuildings(
        testBounds.south, testBounds.west, testBounds.north, testBounds.east, testAnchor,
      );
    } catch (error) {
      capacityError = error instanceof Error ? error.message : String(error);
    }
    assert.match(capacityError, /All Overpass instances are busy/);
    assert.equal(requests.length, 2, 'capacity failure must retry once without recursive subdivision');

    // Explicit resource diagnostics from all endpoints are eligible for tile
    // subdivision; the backend sends a typed query-resource response.
    requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ detail: { message: 'Overpass query timed out', kind: 'query-resource' } }, 422);
    };
    let resourceError = '';
    try {
      await fetchOSMBuildings(
        testBounds.south, testBounds.west, testBounds.north, testBounds.east, testAnchor,
      );
    } catch (error) {
      resourceError = error instanceof Error ? error.message : String(error);
    }
    // The small test tile is already under the child tile size, so it cannot
    // be split further; the explicit resource error is surfaced clearly.
    assert.match(resourceError, /query timed out/);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
}

void runOverpassResilienceFixtures().then(() => {
  process.stdout.write(`OSM parser + ${cityTiles.length} city tiles + same-origin proxy resilience fixtures: PASS\n`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
