// Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
// Upstream: https://github.com/puloktarafder/SionnaRTStudio

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BuildingFootprint, GeoAnchor, Transmitter, Receiver, PropagationPath, ENUVector, MeasurementOverlayPoint } from '../types';
import { cn } from '../lib/utils';
import { enuToLatLon, getSectorHue, isPointInPolygon, latLonToENU } from '../utils';
import { RadioMapGrid } from '../types';
import { ColormapName, sampleColormap } from '../lib/colormaps';
import {
  getDesiredPreviewTolerance,
  getPreviewChunkMeters,
  getPreviewBaseTolerance,
  getPreviewLoadRadius,
  getPreviewUnloadRadius,
  PREVIEW_LOD_CONFIG,
  shouldStreamPreviewChunk,
  shouldUnloadPreviewChunk,
} from '../lib/previewLod';
import { Compass, Activity, Camera } from 'lucide-react';

// Sample the selected colormap at t in [0,1] into `out`.
function colormapColor(name: ColormapName, t: number, out: THREE.Color): THREE.Color {
  const [r, g, b] = sampleColormap(name, t);
  return out.setRGB(r, g, b);
}

// Free the GPU resources (geometry, materials, textures) held by an object tree.
// three.js does not release these on remove(), so skipping this leaks VRAM.
function disposeObject3D(
  obj: THREE.Object3D,
  disposed: { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material>; textures: Set<THREE.Texture> },
) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !disposed.geometries.has(mesh.geometry)) {
      disposed.geometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const material = (mesh as THREE.Mesh).material;
    const mats = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of mats) {
      const materialMaps = m as THREE.Material & Record<string, unknown>;
      for (const property of [
        'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap',
        'envMap', 'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap', 'specularMap',
      ]) {
        const texture = materialMaps[property];
        if (texture instanceof THREE.Texture && !disposed.textures.has(texture)) {
          disposed.textures.add(texture);
          texture.dispose();
        }
      }
      if (!disposed.materials.has(m)) {
        disposed.materials.add(m);
        m.dispose();
      }
    }
  });
}

// Remove and dispose every child of a group.
function clearGroup(group: THREE.Group) {
  const disposed = {
    geometries: new Set<THREE.BufferGeometry>(),
    materials: new Set<THREE.Material>(),
    textures: new Set<THREE.Texture>(),
  };
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject3D(child, disposed);
  }
}

// Merge compatible BufferGeometry objects into one draw call. The caller must
// only batch geometries that share the same material/rendering semantics.
// When the addon cannot merge a batch, callers can retain the originals.
function mergeGeometryBatch(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];
  const merged = mergeGeometries(geometries, false);
  if (!merged) return null;
  geometries.forEach((geometry) => geometry.dispose());
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// Muted, matte building palette in the spirit of Sionna RT's preview renderer
// (earthy tan / beige / sage / mauve / terracotta / slate tones).
const BUILDING_PALETTE = [
  0xb08968, 0xddbea9, 0xa5a58d, 0x9a8c98,
  0xcb997e, 0x8d99ae, 0xb5838d, 0xc9ada7,
];
function buildingColor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BUILDING_PALETTE[h % BUILDING_PALETTE.length];
}

// Yield preview preparation to the browser so input, camera controls and RAF
// rendering remain responsive while city-scale OSM geometry is compiled.
function yieldToNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Remove sub-pixel-scale vertices from the disposable Three.js preview only.
 * The original BuildingFootprint.enuPoints array is never changed and remains
 * the exact input passed to the Sionna RT backend.
 */
function simplifyPreviewPoints(points: ENUVector[], toleranceMeters: number): ENUVector[] {
  if (toleranceMeters <= 0 || points.length <= 4) return points;
  const isClosed = points.length > 3 &&
    Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) < 1e-6;
  const source = isClosed ? points.slice(0, -1) : points;
  if (source.length <= 3) return points;

  const simplified: ENUVector[] = [source[0]];
  const distanceToSegment = (point: ENUVector, start: ENUVector, end: ENUVector) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
  };

  for (let index = 1; index < source.length - 1; index++) {
    const previous = simplified[simplified.length - 1];
    const point = source[index];
    const next = source[index + 1];
    if (distanceToSegment(point, previous, next) >= toleranceMeters) simplified.push(point);
  }
  simplified.push(source[source.length - 1]);
  if (isClosed) simplified.push(simplified[0]);
  return simplified.length >= (isClosed ? 4 : 2) ? simplified : points;
}

// A camera-facing text label (e.g. "Tx 1") rendered as a sprite, for the 3D scene.
function makeLabelSprite(text: string, borderColor: string): THREE.Sprite {
  const fontSize = 48;
  const pad = 18;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `bold ${fontSize}px sans-serif`;
  const tw = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = tw + pad * 2;
  canvas.height = fontSize + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(11,12,14,0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const worldH = 7; // label height in world units
  sprite.scale.set((worldH * canvas.width) / canvas.height, worldH, 1);
  sprite.renderOrder = 20;
  return sprite;
}

// Map-style street text painted into the road plane. It is deliberately not a
// billboard: orbiting/panning the camera must move the name exactly with the
// street, just like text printed on a physical map surface.
function makeStreetLabelMesh(
  text: string,
  segmentLength: number,
  maxAnisotropy: number,
): THREE.Mesh | null {
  const fontSize = 64;
  const padX = 18;
  const padY = 12;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 ${fontSize}px sans-serif`;
  const textWidth = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = textWidth + padX * 2;
  canvas.height = fontSize + padY * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `700 ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.95)';
  ctx.lineWidth = 12;
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  // The asphalt ribbon is 7.5 m wide. A 4.2 m text height gives the label the
  // visual weight of a web-map road name while retaining side clearance.
  const naturalHeight = 4.2;
  const naturalWidth = naturalHeight * canvas.width / canvas.height;
  const maxWidth = Math.min(48, Math.max(7, segmentLength - 4));
  const scale = Math.min(1, maxWidth / naturalWidth);
  if (scale < 0.42) return null; // too cramped to be useful at map scale

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(8, maxAnisotropy);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.08,
    // Respect scene geometry: a road name must not render through a building.
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(naturalWidth * scale, naturalHeight * scale),
    material,
  );
  mesh.renderOrder = 12;
  return mesh;
}

interface ThreeStudioProps {
  buildings: BuildingFootprint[];
  anchor: GeoAnchor;
  tx: Transmitter;
  rx: Receiver;
  txs?: Transmitter[];
  rxs?: Receiver[];
  activeTxId?: string;
  activeRxId?: string;
  paths: PropagationPath[];
  matrixPaths?: PropagationPath[];
  showRaysOnHeatmap?: boolean;
  radioMap: RadioMapGrid | null;
  focusedRadioMapCellIndex?: number | null;
  rmColormap: ColormapName;
  rmAutoRange: boolean;
  rmVmin: number;
  rmVmax: number;
  onTxUpdate: (tx: Transmitter) => void;
  onRxUpdate: (rx: Receiver) => void;
  activeMode: 'link' | 'heatmap' | 'playback';
  placementMode: 'none' | 'tx' | 'rx';
  setPlacementMode: (mode: 'none' | 'tx' | 'rx') => void;
  showOutlines: boolean;
  setShowOutlines: (val: boolean) => void;
  mobilityRxPosition: ENUVector | null;
  trajectoryPoints: { lat: number; lon: number; enu: { x: number; y: number; z: number } }[];
  setTrajectoryPoints: (pts: { lat: number; lon: number; enu: { x: number; y: number; z: number } }[]) => void;
  measurementOverlayPoints: MeasurementOverlayPoint[];
  measurementOverlayLabel: string;
  measurementOverlayVisible: boolean;
  setMeasurementOverlayVisible: (visible: boolean) => void;
}

// Map ENU Vector to Three.js vector
// East (X) -> +X
// North (Y) -> -Z
// Up (Z) -> +Y
function enuToThree(v: ENUVector): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

export function ThreeStudio({
  buildings,
  anchor,
  tx,
  rx,
  txs,
  rxs,
  activeTxId,
  activeRxId,
  paths,
  matrixPaths,
  showRaysOnHeatmap,
  radioMap,
  focusedRadioMapCellIndex = null,
  rmColormap,
  rmAutoRange,
  rmVmin,
  rmVmax,
  onTxUpdate,
  onRxUpdate,
  activeMode,
  placementMode,
  setPlacementMode,
  showOutlines,
  setShowOutlines,
  mobilityRxPosition,
  trajectoryPoints,
  setTrajectoryPoints,
  measurementOverlayPoints,
  measurementOverlayLabel,
  measurementOverlayVisible,
  setMeasurementOverlayVisible
}: ThreeStudioProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const captureScreenshotRef = useRef<(() => void) | null>(null);
  const focusMeasurementOverlayRef = useRef<(() => void) | null>(null);

  const [renderStats, setRenderStats] = useState({
    fps: 0,
    frameP95Ms: 0,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
  });
  const [screenshotStatus, setScreenshotStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [previewProgress, setPreviewProgress] = useState({ loaded: 0, total: 0, refined: 0, streaming: false });
  const [performanceMode, setPerformanceMode] = useState<'high' | 'eco'>('high');
  // LOD controls preview-only geometric simplification. Chunk streaming remains
  // enabled in both modes so a city-sized scene does not exhaust browser memory.
  const [previewLodEnabled, setPreviewLodEnabled] = useState(true);
  const previewLodEnabledRef = useRef(true);
  const previewLodRefreshRef = useRef<(() => void) | null>(null);
  const [cameraMode, setCameraMode] = useState<'orbit' | 'lockTx'>('orbit');
  const [pathDrawingMode, setPathDrawingMode] = useState(false);
  const [radioMapDisplayMode, setRadioMapDisplayMode] = useState<'metric' | 'rss_association' | 'sinr_association' | 'path_gain_association' | 'top_interferer'>('metric');

  const [hoveredCoordinate, setHoveredCoordinate] = useState<ENUVector | null>(null);
  const [hoveredMeasurementPoints, setHoveredMeasurementPoints] = useState<MeasurementOverlayPoint[]>([]);
  useEffect(() => {
    if (!measurementOverlayVisible || measurementOverlayPoints.length === 0) setHoveredMeasurementPoints([]);
  }, [measurementOverlayPoints, measurementOverlayVisible]);

  // Keep references to access them in render loops & events stably
  const stateRef = useRef({
    buildings,
    anchor,
    tx,
    rx,
    txs,
    rxs,
    activeTxId,
    activeRxId,
    paths,
    matrixPaths,
    showRaysOnHeatmap,
    radioMap,
    focusedRadioMapCellIndex,
    radioMapDisplayMode,
    rmColormap,
    rmAutoRange,
    rmVmin,
    rmVmax,
    placementMode,
    activeMode,
    cameraMode,
    showOutlines,
    pathDrawingMode,
    mobilityRxPosition,
    trajectoryPoints,
    setTrajectoryPoints,
    measurementOverlayPoints,
    measurementOverlayLabel,
    measurementOverlayVisible,
    onTxUpdate,
    onRxUpdate,
    setPlacementMode
  });

  useEffect(() => {
    stateRef.current = {
      buildings,
      anchor,
      tx,
      rx,
      txs,
      rxs,
      activeTxId,
      activeRxId,
      paths,
      matrixPaths,
      showRaysOnHeatmap,
      radioMap,
      focusedRadioMapCellIndex,
      radioMapDisplayMode,
      rmColormap,
      rmAutoRange,
      rmVmin,
      rmVmax,
      placementMode,
      activeMode,
      cameraMode,
      showOutlines,
      pathDrawingMode,
      mobilityRxPosition,
      trajectoryPoints,
      setTrajectoryPoints,
      measurementOverlayPoints,
      measurementOverlayLabel,
      measurementOverlayVisible,
      onTxUpdate,
      onRxUpdate,
      setPlacementMode
    };
  }, [buildings, anchor, tx, rx, txs, rxs, activeTxId, activeRxId, paths, matrixPaths, showRaysOnHeatmap, radioMap, focusedRadioMapCellIndex, radioMapDisplayMode, rmColormap, rmAutoRange, rmVmin, rmVmax, placementMode, activeMode, cameraMode, showOutlines, pathDrawingMode, mobilityRxPosition, trajectoryPoints, setTrajectoryPoints, measurementOverlayPoints, measurementOverlayLabel, measurementOverlayVisible, onTxUpdate, onRxUpdate, setPlacementMode]);

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight || 580;

    // 1. Initial Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8fafc); // Bright elegant light mode background
    // No distance fog — it washed the whole scene hazy when zoomed out.

    // 2. Camera Setup. Near plane at 1 (not 0.1) so the depth buffer keeps
    // precision across the large city extent → no z-fighting flicker far out.
    const previewExtent = buildings.reduce((extent, feature) => {
      feature.enuPoints.forEach((point) => {
        extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
      });
      return extent;
    }, 0);
    const previewGroundSize = Math.max(2_000, Math.ceil((previewExtent + 500) * 2));
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, Math.max(6_000, previewGroundSize * 1.8));
    const initialDistance = previewExtent > 600 ? previewExtent * 2.6 : 240;
    camera.position.set(
      0,
      previewExtent > 600 ? initialDistance * 0.55 : 180,
      previewExtent > 600 ? initialDistance * 0.83 : 240,
    );

    // 3. WebGL Renderer. logarithmicDepthBuffer eliminates the flicker between
    // the many coplanar flat layers (ground, grid, roads, parks, water).
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      // Keep one WebGL context across quality-mode changes. Antialias is a
      // context-creation option; the Eco mode instead lowers pixel ratio and
      // disables the shadow pass without destroying/rebuilding the city scene.
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true,
      powerPreference: "high-performance"
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, performanceMode === 'high' ? 2 : 1));
    rendererRef.current = renderer;
    // All relevant preview meshes are shadow-capable. Eco disables the renderer
    // shadow pass; the original geometry and RF simulation never depend on it.
    const shadowsEnabled = true;
    renderer.shadowMap.enabled = performanceMode === 'high';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 4. Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // restrict to ground-level rotations
    controls.screenSpacePanning = true;

    // 5. Lights — soft, even, Sionna-preview style (mostly ambient + sky/ground fill).
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xc7ccd4, 0.6);
    hemiLight.position.set(0, 300, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
    dirLight.position.set(120, 250, 80);
    dirLight.castShadow = shadowsEnabled;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 1000;
    const dSide = 400;
    dirLight.shadow.camera.left = -dSide;
    dirLight.shadow.camera.right = dSide;
    dirLight.shadow.camera.top = dSide;
    dirLight.shadow.camera.bottom = -dSide;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    // Grid Floor matching Light Minimal GIS setup
    const gridDivisions = Math.min(240, Math.max(40, Math.ceil(previewGroundSize / 100)));
    const gridHelper = new THREE.GridHelper(previewGroundSize, gridDivisions, 0x94a3b8, 0xcbd5e1);
    gridHelper.position.y = -0.1;
    scene.add(gridHelper);

    // Ground slab
    const groundGeom = new THREE.PlaneGeometry(previewGroundSize, previewGroundSize);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0, // Elegant deeper slate-200 ground base for maximum contrast against white buildings
      roughness: 0.9,
      metalness: 0.05
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Grouping nodes for logical clear layers
    const buildingGroup = new THREE.Group();
    const streetLabelGroup = new THREE.Group();
    const transmitterGroup = new THREE.Group();
    const receiverGroup = new THREE.Group();
    const pathsGroup = new THREE.Group();
    const heatmapGroup = new THREE.Group();
    const trajectoryGroup = new THREE.Group();
    const measurementGroup = new THREE.Group();
    const interactionGroup = new THREE.Group();
    let measurementPointsCloud: THREE.Points | null = null;
    let measurementPointsCloudPoints: MeasurementOverlayPoint[] = [];

    // Keep the computed radio-map meshes alive while the user switches between
    // Link Analysis / Radio Coverage. The map is an expensive visual layer and
    // its source data lives in App state; changing the active mode must only
    // hide/show this group, not dispose its GPU resources.
    type HeatmapRenderSnapshot = {
      radioMap: RadioMapGrid;
      displayMode: typeof radioMapDisplayMode;
      focusedCellIndex: number | null;
      colormap: ColormapName;
      autoRange: boolean;
      vmin: number;
      vmax: number;
    };
    let renderedHeatmapSnapshot: HeatmapRenderSnapshot | null = null;

    scene.add(buildingGroup);
    scene.add(streetLabelGroup);
    scene.add(transmitterGroup);
    scene.add(receiverGroup);
    scene.add(pathsGroup);
    scene.add(heatmapGroup);
    scene.add(trajectoryGroup);
    scene.add(measurementGroup);
    scene.add(interactionGroup);

    // Build one disposable Three.js LOD representation. `toleranceMeters`
    // affects only preview geometry; source BuildingFootprint objects are read-only.
    async function buildPreviewChunk(
      chunkBuildings: BuildingFootprint[],
      chunkRoot: THREE.Group,
      chunkLabelRoot: THREE.Group,
      toleranceMeters: number,
      generation: number,
      pickMeshes: THREE.Mesh[] | null = null,
    ): Promise<boolean> {
      if (generation !== previewBuildGeneration) return false;
      const current = stateRef.current;
      const isDetailedPreview = toleranceMeters <= PREVIEW_LOD_CONFIG.mediumToleranceMeters;
      const drawPreviewOutlines = current.showOutlines && isDetailedPreview;
      const buildingBatches = new Map<string, THREE.BufferGeometry[]>();
      const outlineBatches = new Map<string, THREE.BufferGeometry[]>();
      const roadBatches = new Map<string, THREE.BufferGeometry[]>();
      const roadDashBatches = new Map<string, THREE.BufferGeometry[]>();
      const terrainBatches = new Map<string, THREE.BufferGeometry[]>();
      const waterBatches = new Map<string, THREE.BufferGeometry[]>();
      const treeInstancesByChunk = new Map<string, {
        x: number; z: number; trunkHeight: number; canopyHeight: number;
        canopyRadius: number; canopyColor: number;
      }[]>();
      type NamedStreetSegment = {
        key: string;
        name: string;
        length: number;
        startX: number;
        startZ: number;
        endX: number;
        endZ: number;
        angle: number;
      };
      const namedStreetSegments: NamedStreetSegment[] = [];

      const FEATURE_BATCH_SIZE = PREVIEW_LOD_CONFIG.featureBatchSize;
      for (let offset = 0; offset < chunkBuildings.length; offset += FEATURE_BATCH_SIZE) {
        const featureBatch = chunkBuildings.slice(offset, offset + FEATURE_BATCH_SIZE);
        featureBatch.forEach(b => {
        const pts = simplifyPreviewPoints(b.enuPoints, toleranceMeters);
        if (pts.length < 2) return;

        // --- 1. ROADS / STREETS (INFRASTRUCTURE) ---
        if (b.category === 'infrastructure') {
          // Render a thick, stylish asphalt ribbon for each segment
          for (let i = 0; i < pts.length - 1; i++) {
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y; // North-South
            const segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.1) continue;

            const mx = (p1.x + p2.x) / 2;
            const mz = -(p1.y + p2.y) / 2; // Negate North-South for Three.js Z-axis
            const angle = Math.atan2(dy, dx); // Angle of rotation in XZ

            // Preserve every named segment. The layout pass below repeats a
            // street name at controlled intervals across its visible extent.
            const streetName = b.name?.trim();
            if (streetName && isDetailedPreview) {
              const key = streetName.toLocaleLowerCase();
              let labelAngle = angle;
              // Choose one consistent reading direction for the north-up
              // scene while keeping the text baseline parallel to the road.
              if (labelAngle > Math.PI / 2) labelAngle -= Math.PI;
              if (labelAngle < -Math.PI / 2) labelAngle += Math.PI;
              namedStreetSegments.push({
                key,
                name: streetName,
                length: segLen,
                startX: p1.x,
                startZ: -p1.y,
                endX: p2.x,
                endZ: -p2.y,
                angle: labelAngle,
              });
            }

            // Use a gorgeous, high-contrast dark asphalt ribbon (strongly distinct against ground and buildings)
            const roadGeom = new THREE.PlaneGeometry(segLen, 7.5);
            roadGeom.rotateX(-Math.PI / 2); // Lay flat
            roadGeom.rotateY(angle); // Polar rotate

            roadGeom.translate(mx, 0.12, mz); // distinct layer height to prevent z-fighting
            const roadChunk = chunkFor(mx, mz);
            const roadGeometries = roadBatches.get(roadChunk) ?? [];
            roadGeometries.push(roadGeom);
            roadBatches.set(roadChunk, roadGeometries);

            // Add center dashes to one chunked geometry per spatial tile.
            if (drawPreviewOutlines) {
              const dashGeom = new THREE.PlaneGeometry(segLen * 0.95, 0.25);
              dashGeom.rotateX(-Math.PI / 2);
              dashGeom.rotateY(angle);
              dashGeom.translate(mx, 0.018, mz);
              const dashGeometries = roadDashBatches.get(roadChunk) ?? [];
              dashGeometries.push(dashGeom);
              roadDashBatches.set(roadChunk, dashGeometries);
            }
          }
          return; // skip extrusion
        }

        // --- 2. VEGETATION / FLAT GREEN TERRAIN ---
        if (b.category === 'terrain') {
          if (pts.length < 3) return;

          // Draw green park polygons
          const shape = new THREE.Shape();
          shape.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            shape.lineTo(pts[i].x, pts[i].y);
          }
          shape.closePath();

          const terrainGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
          terrainGeom.rotateX(-Math.PI / 2);
          terrainGeom.translate(0, 0.05, 0);
          const terrainCenter = pts.reduce((acc, point) => ({
            x: acc.x + point.x / pts.length,
            y: acc.y + point.y / pts.length,
          }), { x: 0, y: 0 });
          const terrainChunk = chunkFor(terrainCenter.x, -terrainCenter.y);
          const terrainGeometries = terrainBatches.get(terrainChunk) ?? [];
          terrainGeometries.push(terrainGeom);
          terrainBatches.set(terrainChunk, terrainGeometries);

          // Park trees are decorative preview assets. Build them only for medium
          // and high detail tiers; coarse city overviews retain the park polygon.
          if (!isDetailedPreview) return;

          // Add beautiful 3D low-poly conifer trees scattered inside the park area!
          // Compute simple 2D bounding box
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          pts.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          });

          // Seeded random tree generation to make it deterministic across rerenders
          let seed = b.id.charCodeAt(b.id.length - 1) || 42;
          const randomSeeded = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
          };

          // Scatter trees proportional to park area
          const area = (maxX - minX) * (maxY - minY);
          const numTrees = Math.min(12, Math.max(3, Math.floor(area / 300)));

          for (let t = 0; t < numTrees; t++) {
            const rx = minX + randomSeeded() * (maxX - minX);
            const ry = minY + randomSeeded() * (maxY - minY);

            // Verify if point is physically inside the park footprint
            if (isDetailedPreview && isPointInPolygon({ x: rx, y: ry }, b.enuPoints)) {
              const trunkHeight = 1.2 + randomSeeded() * 1.2;
              const canopyHeight = 2.0 + randomSeeded() * 1.8;
              const canopyRadius = 0.7 + randomSeeded() * 0.7;
              const leafColors = [0x166534, 0x15803d, 0x14532d, 0x15803d];
              const leafColor = leafColors[Math.floor(randomSeeded() * leafColors.length)];
              const treeChunk = chunkFor(rx, -ry);
              const treeInstances = treeInstancesByChunk.get(treeChunk) ?? [];
              treeInstances.push({
                x: rx,
                z: -ry,
                trunkHeight,
                canopyHeight,
                canopyRadius,
                canopyColor: leafColor,
              });
              treeInstancesByChunk.set(treeChunk, treeInstances);
            }
          }
          return;
        }

        // --- 3. WATER BODIES (LAKES / RIVER PIPELINE) ---
        if (b.category === 'water') {
          if (pts.length < 3) return;

          const shape = new THREE.Shape();
          shape.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            shape.lineTo(pts[i].x, pts[i].y);
          }
          shape.closePath();

          const waterGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
          waterGeom.rotateX(-Math.PI / 2);
          waterGeom.translate(0, 0.08, 0);
          const waterCenter = pts.reduce((acc, point) => ({
            x: acc.x + point.x / pts.length,
            y: acc.y + point.y / pts.length,
          }), { x: 0, y: 0 });
          const waterChunk = chunkFor(waterCenter.x, -waterCenter.y);
          const waterGeometries = waterBatches.get(waterChunk) ?? [];
          waterGeometries.push(waterGeom);
          waterBatches.set(waterChunk, waterGeometries);
          return;
        }

        // --- 4. BUILDINGS (DEFAULT RENDERING) ---
        if (pts.length < 3) return;

        const h = b.height;
        const shape = new THREE.Shape();
        // Shape works in 2D coordinates
        // Map East (X) and North (Y) to keep exact rotation directions
        shape.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          shape.lineTo(pts[i].x, pts[i].y);
        }
        shape.closePath();

        const extrudeSettings = {
          depth: h,
          bevelEnabled: false
        };

        const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        // Rotate so depth matches +Y height upright
        geom.rotateX(-Math.PI / 2);

        // Matte, muted, solid buildings — matches Sionna RT's preview look.
        // Each building gets a deterministic earthy vertex colour. The
        // geometry is merged by spatial chunk, not by colour, to minimise
        // draw calls while retaining chunk-level frustum culling.
        const centroid = pts.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
        centroid.x /= pts.length;
        centroid.y /= pts.length;
        const chunk = chunkFor(centroid.x, -centroid.y);
        const color = new THREE.Color(buildingColor(b.id));
        const positionAttribute = geom.getAttribute('position');
        const vertexColors = new Float32Array(positionAttribute.count * 3);
        for (let vertex = 0; vertex < positionAttribute.count; vertex++) {
          const offset = vertex * 3;
          vertexColors[offset] = color.r;
          vertexColors[offset + 1] = color.g;
          vertexColors[offset + 2] = color.b;
        }
        geom.setAttribute('color', new THREE.Float32BufferAttribute(vertexColors, 3));
        const buildingGeometries = buildingBatches.get(chunk) ?? [];
        buildingGeometries.push(geom);
        buildingBatches.set(chunk, buildingGeometries);

        // Optional blueprint edge outlines are batched separately so their
        // single shared line material can render each chunk in one call.
        if (drawPreviewOutlines) {
          const edgeGeometries = outlineBatches.get(chunkFor(centroid.x, -centroid.y)) ?? [];
          edgeGeometries.push(new THREE.EdgesGeometry(geom));
          outlineBatches.set(chunkFor(centroid.x, -centroid.y), edgeGeometries);
        }
        });
        await yieldToNextFrame();
        if (generation !== previewBuildGeneration) return false;
      }

      // Finalize chunked roads. Every chunk now has one road mesh and (when
      // enabled) one lane-marking mesh instead of one mesh per OSM segment.
      const roadMaterial = new THREE.MeshStandardMaterial({
        color: 0x334155, roughness: 0.85, metalness: 0.1,
      });
      roadBatches.forEach((geometries, chunk) => {
        const merged = mergeGeometryBatch(geometries);
        if (merged) {
          const mesh = new THREE.Mesh(merged, roadMaterial.clone());
          mesh.name = `roads-${chunk}`;
          mesh.receiveShadow = shadowsEnabled;
          chunkRoot.add(mesh);
        } else {
          // Safe fallback for a heterogeneous or otherwise non-mergeable batch.
          geometries.forEach((geometry, index) => {
            const mesh = new THREE.Mesh(geometry, roadMaterial.clone());
            mesh.name = `road-${chunk}-${index}`;
            mesh.receiveShadow = shadowsEnabled;
            chunkRoot.add(mesh);
          });
        }
      });
      roadMaterial.dispose();

      const dashMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
      });
      roadDashBatches.forEach((geometries, chunk) => {
        const merged = mergeGeometryBatch(geometries);
        if (merged) {
          const mesh = new THREE.Mesh(merged, dashMaterial.clone());
          mesh.name = `road-dashes-${chunk}`;
          chunkRoot.add(mesh);
        } else {
          geometries.forEach((geometry, index) => {
            const mesh = new THREE.Mesh(geometry, dashMaterial.clone());
            mesh.name = `road-dash-${chunk}-${index}`;
            chunkRoot.add(mesh);
          });
        }
      });
      dashMaterial.dispose();

      // Each building keeps its deterministic palette colour in a vertex
      // attribute, allowing one draw call per spatial chunk instead of one per
      // (chunk × palette colour). This changes only preview shading.
      const buildingMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.97, metalness: 0.0, flatShading: true,
      });
      buildingBatches.forEach((geometries, chunk) => {
        const merged = mergeGeometryBatch(geometries);
        const addBuildingMesh = (geometry: THREE.BufferGeometry, suffix: string) => {
          const mesh = new THREE.Mesh(geometry, buildingMaterial);
          mesh.castShadow = shadowsEnabled;
          mesh.receiveShadow = shadowsEnabled;
          mesh.name = `building-batch-${chunk}-${suffix}`;
          chunkRoot.add(mesh);
          if (pickMeshes) pickMeshes.push(mesh);
        };
        if (merged) {
          addBuildingMesh(merged, 'merged');
        } else {
          geometries.forEach((geometry, index) => addBuildingMesh(geometry, String(index)));
        }
      });

      // Terrain and water polygons are also batched by spatial chunk. They are
      // visual context only; the original OSM feature array remains untouched.
      const terrainMaterial = new THREE.MeshStandardMaterial({
        color: 0x86efac, roughness: 0.9, metalness: 0.05,
      });
      terrainBatches.forEach((geometries, chunk) => {
        const merged = mergeGeometryBatch(geometries);
        if (merged) {
          const mesh = new THREE.Mesh(merged, terrainMaterial);
          mesh.name = `terrain-${chunk}`;
          mesh.receiveShadow = shadowsEnabled;
          chunkRoot.add(mesh);
        } else {
          geometries.forEach((geometry, index) => {
            const mesh = new THREE.Mesh(geometry, terrainMaterial);
            mesh.name = `terrain-${chunk}-${index}`;
            mesh.receiveShadow = shadowsEnabled;
            chunkRoot.add(mesh);
          });
        }
      });

      const waterMaterial = new THREE.MeshStandardMaterial({
        color: 0x0ea5e9, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.95,
      });
      waterBatches.forEach((geometries, chunk) => {
        const merged = mergeGeometryBatch(geometries);
        if (merged) {
          const mesh = new THREE.Mesh(merged, waterMaterial);
          mesh.name = `water-${chunk}`;
          chunkRoot.add(mesh);
        } else {
          geometries.forEach((geometry, index) => {
            const mesh = new THREE.Mesh(geometry, waterMaterial);
            mesh.name = `water-${chunk}-${index}`;
            chunkRoot.add(mesh);
          });
        }
      });

      // Parks can contain hundreds of individual low-poly trees. Two
      // InstancedMeshes per spatial chunk replace two Mesh objects per tree,
      // retaining each tree's deterministic size and canopy colour.
      if (treeInstancesByChunk.size > 0) {
        const trunkGeometry = new THREE.CylinderGeometry(0.18, 0.25, 1, 5);
        const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.95 });
        const canopyGeometry = new THREE.ConeGeometry(1, 1, 5);
        const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
        const dummy = new THREE.Object3D();

        treeInstancesByChunk.forEach((instances, chunk) => {
          const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, instances.length);
          const canopies = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, instances.length);
          trunks.name = `park-tree-trunks-${chunk}`;
          canopies.name = `park-tree-canopies-${chunk}`;
          instances.forEach((tree, index) => {
            dummy.position.set(tree.x, 0.09 + tree.trunkHeight / 2, tree.z);
            dummy.scale.set(1, tree.trunkHeight, 1);
            dummy.updateMatrix();
            trunks.setMatrixAt(index, dummy.matrix);

            dummy.position.set(
              tree.x,
              0.09 + tree.trunkHeight + tree.canopyHeight / 2 - 0.25,
              tree.z,
            );
            dummy.scale.set(tree.canopyRadius, tree.canopyHeight, tree.canopyRadius);
            dummy.updateMatrix();
            canopies.setMatrixAt(index, dummy.matrix);
            canopies.setColorAt(index, new THREE.Color(tree.canopyColor));
          });
          trunks.instanceMatrix.needsUpdate = true;
          canopies.instanceMatrix.needsUpdate = true;
          if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
          trunks.computeBoundingSphere();
          canopies.computeBoundingSphere();
          chunkRoot.add(trunks, canopies);
        });
      }

      if (drawPreviewOutlines) {
        const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x1e293b, linewidth: 1.5 });
        outlineBatches.forEach((geometries, chunk) => {
          const merged = mergeGeometryBatch(geometries);
          if (merged) {
            const lines = new THREE.LineSegments(merged, outlineMaterial.clone());
            lines.name = `building-outlines-${chunk}`;
            chunkRoot.add(lines);
          } else {
            geometries.forEach((geometry, index) => {
              const lines = new THREE.LineSegments(geometry, outlineMaterial.clone());
              lines.name = `building-outline-${chunk}-${index}`;
              chunkRoot.add(lines);
            });
          }
        });
        outlineMaterial.dispose();
      }

      // OSM splits roads at junctions and sometimes across multiple ways. Group
      // all pieces by normalized name, then place repeated labels roughly every
      // block along the visible street. Limits prevent dense maps from turning
      // into a wall of text.
      const segmentsByStreet = new Map<string, NamedStreetSegment[]>();
      namedStreetSegments.forEach((segment) => {
        const group = segmentsByStreet.get(segment.key) ?? [];
        group.push(segment);
        segmentsByStreet.set(segment.key, group);
      });

      const MAX_LABELS_PER_STREET = 4;
      const MAX_TOTAL_STREET_LABELS = chunkBuildings.length > 25_000
        ? 500
        : chunkBuildings.length > 8_000
          ? 1_000
          : 1_800;
      const TARGET_REPEAT_METERS = 110;
      const MIN_REPEAT_SPACING_METERS = 65;
      const MIN_CROSS_STREET_SPACING_METERS = 12;
      const occupied: { x: number; z: number }[] = [];

      let totalStreetLabels = 0;
      segmentsByStreet.forEach((segments) => {
        if (totalStreetLabels >= MAX_TOTAL_STREET_LABELS) return;
        const totalVisibleLength = segments.reduce((sum, segment) => sum + segment.length, 0);
        const accepted: { x: number; z: number }[] = [];
        for (const segment of segments) {
          if (accepted.length >= MAX_LABELS_PER_STREET || totalStreetLabels >= MAX_TOTAL_STREET_LABELS) break;

          const count = Math.min(
            MAX_LABELS_PER_STREET - accepted.length,
            Math.max(1, Math.ceil(segment.length / TARGET_REPEAT_METERS)),
          );
          const slotLength = segment.length / count;

          for (let index = 0; index < count; index++) {
            if (accepted.length >= MAX_LABELS_PER_STREET) break;
            const fraction = (index + 0.5) / count;
            const x = THREE.MathUtils.lerp(segment.startX, segment.endX, fraction);
            const z = THREE.MathUtils.lerp(segment.startZ, segment.endZ, fraction);
            const distanceTo = (point: { x: number; z: number }) =>
              Math.hypot(x - point.x, z - point.z);

            if (accepted.some((point) => distanceTo(point) < MIN_REPEAT_SPACING_METERS)) continue;
            if (occupied.some((point) => distanceTo(point) < MIN_CROSS_STREET_SPACING_METERS)) continue;

            const label = makeStreetLabelMesh(
              segment.name,
              // Curved OSM ways are often made of many short line segments.
              // Let a label span adjacent pieces when the named street has
              // enough total visible length, rather than dropping every name.
              Math.max(slotLength, Math.min(TARGET_REPEAT_METERS, totalVisibleLength)),
              renderer.capabilities.getMaxAnisotropy(),
            );
            if (!label) continue;

            // Apply rotations to the geometry in the same order as the asphalt
            // ribbon above. This keeps the decal fixed to the road during orbit.
            label.geometry.rotateX(-Math.PI / 2);
            label.geometry.rotateY(segment.angle);
            label.position.set(x, 0.24, z);
            chunkLabelRoot.add(label);
            const position = { x, z };
            accepted.push(position);
            occupied.push(position);
            totalStreetLabels++;
          }
        }
      });

      return generation === previewBuildGeneration;
    }
    // City-scale preview pipeline. OSM features remain authoritative input data;
    // only disposable Three.js groups are streamed and assigned LOD tiers.
    const PREVIEW_CHUNK_METERS = getPreviewChunkMeters(buildings.length);
    const PREVIEW_MEDIUM_DETAIL_EXIT_METERS = PREVIEW_LOD_CONFIG.mediumDetailExitMeters;
    const PREVIEW_MAX_REFINED_CHUNKS = PREVIEW_LOD_CONFIG.maxRefinedChunks;
    const chunkFor = (x: number, y: number) =>
      `${Math.floor(x / PREVIEW_CHUNK_METERS)}:${Math.floor(y / PREVIEW_CHUNK_METERS)}`;

    type PreviewChunkRecord = {
      key: string;
      features: BuildingFootprint[];
      centerX: number;
      centerZ: number;
      boundsRadius: number;
      boundsSphere: THREE.Sphere;
      coarseGroup: THREE.Group | null;
      coarseLabels: THREE.Group | null;
      coarsePickMeshes: THREE.Mesh[];
      refinedGroup: THREE.Group | null;
      refinedLabels: THREE.Group | null;
      refinedPickMeshes: THREE.Mesh[];
      pickTier: 'coarse' | 'refined';
      refinedTolerance: number | null;
      loading: boolean;
      refining: boolean;
      lastTouched: number;
      failureCount: number;
      retryAfter: number;
    };

    const previewChunks = new Map<string, PreviewChunkRecord>();
    const previewFrustumMatrix = new THREE.Matrix4();
    const previewFrustum = new THREE.Frustum();
    let previewBuildGeneration = 0;
    let previewJobBusy = false;
    let lastPreviewJobTime = 0;
    let loadedPreviewChunkCount = 0;

    const residentPreviewChunks = new Set<PreviewChunkRecord>();
    const buildingPickMeshes: THREE.Mesh[] = [];
    const rooftopBuildingsByChunk = new Map<string, BuildingFootprint[]>();
    const rooftopLargeBuildings: BuildingFootprint[] = [];

    const rooftopHeightAt = (enu: { x: number; y: number }) => {
      const candidates = rooftopBuildingsByChunk.get(chunkFor(enu.x, -enu.y)) ?? [];
      const footprint = [...candidates, ...rooftopLargeBuildings].find(
        (b) => b.category === 'building' && b.enuPoints.length >= 3 && isPointInPolygon(enu, b.enuPoints),
      );
      return footprint?.height ?? 0;
    };

    function clearPreviewChunk(record: PreviewChunkRecord) {
      if (record.coarseGroup) loadedPreviewChunkCount = Math.max(0, loadedPreviewChunkCount - 1);
      residentPreviewChunks.delete(record);
      const ownedPickMeshes = new Set([...record.coarsePickMeshes, ...record.refinedPickMeshes]);
      for (let index = buildingPickMeshes.length - 1; index >= 0; index--) {
        if (ownedPickMeshes.has(buildingPickMeshes[index])) buildingPickMeshes.splice(index, 1);
      }
      record.coarsePickMeshes = [];
      record.refinedPickMeshes = [];
      if (record.coarseGroup) {
        buildingGroup.remove(record.coarseGroup);
        clearGroup(record.coarseGroup);
        record.coarseGroup = null;
      }
      if (record.coarseLabels) {
        streetLabelGroup.remove(record.coarseLabels);
        clearGroup(record.coarseLabels);
        record.coarseLabels = null;
      }
      if (record.refinedGroup) {
        buildingGroup.remove(record.refinedGroup);
        clearGroup(record.refinedGroup);
        record.refinedGroup = null;
      }
      if (record.refinedLabels) {
        streetLabelGroup.remove(record.refinedLabels);
        clearGroup(record.refinedLabels);
        record.refinedLabels = null;
      }
      record.refinedTolerance = null;
      record.loading = false;
      record.refining = false;
    }

    function disposeRefinedChunk(record: PreviewChunkRecord) {
      if (record.pickTier === 'refined') setChunkPickTier(record, 'coarse');
      if (record.refinedGroup) {
        buildingGroup.remove(record.refinedGroup);
        clearGroup(record.refinedGroup);
        record.refinedGroup = null;
      }
      if (record.refinedLabels) {
        streetLabelGroup.remove(record.refinedLabels);
        clearGroup(record.refinedLabels);
        record.refinedLabels = null;
      }
      record.refinedPickMeshes = [];
      record.refinedTolerance = null;
    }

    function setChunkPickTier(record: PreviewChunkRecord, tier: 'coarse' | 'refined') {
      if (record.pickTier === tier) return;
      const previous = record.pickTier === 'coarse' ? record.coarsePickMeshes : record.refinedPickMeshes;
      const next = tier === 'coarse' ? record.coarsePickMeshes : record.refinedPickMeshes;
      const previousSet = new Set(previous);
      for (let index = buildingPickMeshes.length - 1; index >= 0; index--) {
        if (previousSet.has(buildingPickMeshes[index])) buildingPickMeshes.splice(index, 1);
      }
      buildingPickMeshes.push(...next);
      record.pickTier = tier;
    }

    function chunkCameraDistance(record: PreviewChunkRecord) {
      return Math.hypot(camera.position.x - record.centerX, camera.position.z - record.centerZ);
    }

    function getCameraFrustum() {
      camera.updateMatrixWorld();
      previewFrustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      return previewFrustum.setFromProjectionMatrix(previewFrustumMatrix);
    }

    async function rebuildBuildings3D() {
      const generation = ++previewBuildGeneration;
      setPreviewProgress({ loaded: 0, total: 0, refined: 0, streaming: true });
      clearGroup(buildingGroup);
      clearGroup(streetLabelGroup);
      // Drop stale raycast references when the OSM scene or outline option rebuilds.
      buildingPickMeshes.length = 0;
      residentPreviewChunks.clear();
      rooftopBuildingsByChunk.clear();
      rooftopLargeBuildings.length = 0;
      previewChunks.clear();
      loadedPreviewChunkCount = 0;

      const current = stateRef.current;
      const groupedFeatures = new Map<string, BuildingFootprint[]>();
      const chunkSize = PREVIEW_CHUNK_METERS;

      // Index exact unsimplified building footprints once. LOD never participates
      // in rooftop placement, click handling, or the physical simulation input.
      for (let index = 0; index < current.buildings.length; index++) {
        if (generation !== previewBuildGeneration) return;
        const feature = current.buildings[index];
        if (!feature.enuPoints || feature.enuPoints.length < 2) continue;

        let sx = 0;
        let sy = 0;
        for (const point of feature.enuPoints) {
          sx += point.x;
          sy += point.y;
        }
        const centerX = sx / feature.enuPoints.length;
        const centerZ = -sy / feature.enuPoints.length;
        const key = chunkFor(centerX, centerZ);
        const items = groupedFeatures.get(key) ?? [];
        items.push(feature);
        groupedFeatures.set(key, items);

        if (feature.category === 'building' && feature.enuPoints.length >= 3) {
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const point of feature.enuPoints) {
            minX = Math.min(minX, point.x);
            maxX = Math.max(maxX, point.x);
            minZ = Math.min(minZ, -point.y);
            maxZ = Math.max(maxZ, -point.y);
          }
          const minChunkX = Math.floor(minX / chunkSize);
          const maxChunkX = Math.floor(maxX / chunkSize);
          const minChunkZ = Math.floor(minZ / chunkSize);
          const maxChunkZ = Math.floor(maxZ / chunkSize);
          const occupiedCells = (maxChunkX - minChunkX + 1) * (maxChunkZ - minChunkZ + 1);
          if (occupiedCells > 64) {
            rooftopLargeBuildings.push(feature);
          } else {
            for (let x = minChunkX; x <= maxChunkX; x++) {
              for (let z = minChunkZ; z <= maxChunkZ; z++) {
                const roofKey = `${x}:${z}`;
                const candidates = rooftopBuildingsByChunk.get(roofKey) ?? [];
                candidates.push(feature);
                rooftopBuildingsByChunk.set(roofKey, candidates);
              }
            }
          }
        }

        if (index > 0 && index % 1_200 === 0) await yieldToNextFrame();
      }

      const records: PreviewChunkRecord[] = [];
      let indexedChunkCount = 0;
      for (const [key, features] of groupedFeatures) {
        const [cx, cz] = key.split(':').map(Number);
        const centerX = (cx + 0.5) * chunkSize;
        const centerZ = (cz + 0.5) * chunkSize;
        let boundsRadius = chunkSize * PREVIEW_LOD_CONFIG.coarseChunkSphereFactor;
        for (const feature of features) {
          for (const point of feature.enuPoints) {
            const verticalExtent = feature.category === 'building' ? Math.max(0, feature.height) : 0;
            boundsRadius = Math.max(
              boundsRadius,
              Math.hypot(point.x - centerX, verticalExtent, -point.y - centerZ),
            );
          }
        }
        records.push({
          key,
          features,
          centerX,
          centerZ,
          boundsRadius,
          boundsSphere: new THREE.Sphere(new THREE.Vector3(centerX, 0, centerZ), boundsRadius),
          coarseGroup: null,
          coarseLabels: null,
          coarsePickMeshes: [],
          refinedGroup: null,
          refinedLabels: null,
          refinedPickMeshes: [],
          pickTier: 'coarse',
          refinedTolerance: null,
          loading: false,
          refining: false,
          lastTouched: 0,
          failureCount: 0,
          retryAfter: 0,
        });
        indexedChunkCount++;
        if (indexedChunkCount % 24 === 0) await yieldToNextFrame();
        if (generation !== previewBuildGeneration) return;
      }
      records.sort((a, b) => chunkCameraDistance(a) - chunkCameraDistance(b));
      records.forEach((record) => previewChunks.set(record.key, record));
      setPreviewProgress({ loaded: 0, total: records.length, refined: 0, streaming: records.length > 0 });
    }

    async function pumpPreviewJobs() {
      const generation = previewBuildGeneration;
      if (previewJobBusy || generation === 0) return;
      previewJobBusy = true;
      let activeRecord: PreviewChunkRecord | null = null;
      let activeTemporaryGroups: THREE.Group[] = [];
      try {
        while (generation === previewBuildGeneration) {
          camera.updateMatrixWorld();
          const frustum = getCameraFrustum();
          const cameraDistance = camera.position.distanceTo(controls.target);
          const loadRadius = getPreviewLoadRadius(cameraDistance);
          const unloadRadius = getPreviewUnloadRadius(loadRadius);
          const isInFrustum = (record: PreviewChunkRecord) => frustum.intersectsSphere(record.boundsSphere);

          // Keep the GPU working set bounded: distant chunks are removed from the
          // preview scene and GPU memory, while their original OSM features stay
          // in the CPU-side project array and can be streamed again on demand.
          for (const record of previewChunks.values()) {
            if (!record.coarseGroup || record.loading || record.refining) continue;
            const distance = chunkCameraDistance(record);
            if (distance > PREVIEW_MEDIUM_DETAIL_EXIT_METERS * 1.2 && record.refinedGroup && !record.refining) {
              disposeRefinedChunk(record);
            }
            if (shouldUnloadPreviewChunk(distance, unloadRadius, record.boundsRadius, isInFrustum(record))) {
              clearPreviewChunk(record);
            }
          }

          // Build a sorted snapshot of coarse candidates once per pump pass. The
          // previous one-chunk-per-loop implementation rescanned and resorted the
          // entire city map for every chunk (O(chunks²) on large city scenes).
          const coarseCandidates = [...previewChunks.values()]
            .filter((record) => !record.coarseGroup && !record.loading && record.retryAfter <= performance.now())
            .map((record) => ({ record, distance: chunkCameraDistance(record), visible: isInFrustum(record) }))
            .filter(({ record, distance, visible }) => shouldStreamPreviewChunk(
              distance, loadRadius, record.boundsRadius, visible, PREVIEW_CHUNK_METERS,
            ))
            .sort((a, b) => a.distance - b.distance);

          if (coarseCandidates.length > 0) {
            for (const candidate of coarseCandidates) {
              if (generation !== previewBuildGeneration) return;
              const coarseCandidate = candidate.record;
              if (coarseCandidate.coarseGroup || coarseCandidate.loading || coarseCandidate.retryAfter > performance.now()) continue;

              // Revalidate against the latest camera position: the camera may have
              // moved while an earlier chunk was being compiled across RAF yields.
              camera.updateMatrixWorld();
              const currentFrustum = getCameraFrustum();
              const currentDistance = chunkCameraDistance(coarseCandidate);
              const currentLoadRadius = getPreviewLoadRadius(camera.position.distanceTo(controls.target));
              const currentVisible = currentFrustum.intersectsSphere(coarseCandidate.boundsSphere);
              if (!shouldStreamPreviewChunk(
                currentDistance, currentLoadRadius, coarseCandidate.boundsRadius,
                currentVisible, PREVIEW_CHUNK_METERS,
              )) continue;

              setPreviewProgress((previous) => ({ ...previous, streaming: true }));
              coarseCandidate.loading = true;
              activeRecord = coarseCandidate;
              const coarseGroup = new THREE.Group();
              const coarseLabels = new THREE.Group();
              const coarsePickMeshes: THREE.Mesh[] = [];
              activeTemporaryGroups.push(coarseGroup, coarseLabels);
              coarseGroup.name = `preview-coarse-${coarseCandidate.key}`;
              coarseLabels.name = `preview-labels-coarse-${coarseCandidate.key}`;
              const baseTolerance = getPreviewBaseTolerance(previewLodEnabledRef.current, buildings.length);
              const built = await buildPreviewChunk(
                coarseCandidate.features, coarseGroup, coarseLabels,
                baseTolerance, generation, coarsePickMeshes,
              );
              if (generation !== previewBuildGeneration) {
                clearGroup(coarseGroup);
                clearGroup(coarseLabels);
                activeTemporaryGroups = [];
                return;
              }
              coarseCandidate.loading = false;
              activeRecord = null;
              activeTemporaryGroups = [];
              if (built) {
                coarseCandidate.failureCount = 0;
                coarseCandidate.retryAfter = 0;
                coarseCandidate.coarseGroup = coarseGroup;
                coarseCandidate.coarseLabels = coarseLabels;
                coarseCandidate.coarsePickMeshes = coarsePickMeshes;
                coarseCandidate.pickTier = 'coarse';
                buildingPickMeshes.push(...coarsePickMeshes);
                coarseCandidate.lastTouched = performance.now();
                buildingGroup.add(coarseGroup);
                streetLabelGroup.add(coarseLabels);
                residentPreviewChunks.add(coarseCandidate);
                loadedPreviewChunkCount++;
                if (loadedPreviewChunkCount % 4 === 0 || loadedPreviewChunkCount === previewChunks.size) {
                  setPreviewProgress((previous) => ({
                    ...previous, loaded: loadedPreviewChunkCount, total: previewChunks.size, streaming: true,
                  }));
                }
              } else {
                clearGroup(coarseGroup);
                clearGroup(coarseLabels);
              }
            }
            // After a batch, recalculate camera/frustum before refining.
            continue;
          }

          // Refine only chunks close to the camera. The far representation stays
          // resident as a fallback; detailed tiers are generated in the background.
          const refinedCount = previewLodEnabledRef.current
            ? [...previewChunks.values()].filter((record) => !!record.refinedGroup).length
            : 0;
          let refineCandidate = previewLodEnabledRef.current ? [...previewChunks.values()]
            .filter((record) => !!record.coarseGroup && !record.refining && record.retryAfter <= performance.now())
            .map((record) => ({ record, distance: chunkCameraDistance(record) }))
            .map(({ record, distance }) => ({
              record,
              distance,
              tolerance: getDesiredPreviewTolerance(distance, record.refinedTolerance),
            }))
            .filter(({ record, tolerance }) => tolerance !== null && (
              (record.refinedGroup && record.refinedTolerance !== null && Math.abs(record.refinedTolerance - tolerance) > 1e-6) ||
              (!record.refinedGroup)
            ))
            .sort((a, b) => a.distance - b.distance)[0] : undefined;

          // Keep detailed GPU residency bounded. If the cap is reached, replace
          // the farthest resident detail chunk only when the requested chunk is
          // closer; this prevents old city blocks from starving the current view.
          if (refineCandidate && !refineCandidate.record.refinedGroup && refinedCount >= PREVIEW_MAX_REFINED_CHUNKS) {
            const victim = [...previewChunks.values()]
              .filter((record) => !!record.refinedGroup && !record.refining && record !== refineCandidate?.record)
              .map((record) => ({ record, distance: chunkCameraDistance(record) }))
              .sort((a, b) => b.distance - a.distance || a.record.lastTouched - b.record.lastTouched)[0];
            if (victim && victim.distance > refineCandidate.distance + PREVIEW_CHUNK_METERS * 0.25) {
              disposeRefinedChunk(victim.record);
            } else {
              refineCandidate = undefined;
            }
          }

          if (refineCandidate) {
            setPreviewProgress((previous) => ({ ...previous, streaming: true }));
            const record = refineCandidate.record;
            const tolerance = refineCandidate.tolerance as number;
            record.refining = true;
            activeRecord = record;
            const refinedGroup = new THREE.Group();
            const refinedLabels = new THREE.Group();
            refinedGroup.visible = false;
            refinedLabels.visible = false;
            const refinedPickMeshes: THREE.Mesh[] = [];
            activeTemporaryGroups.push(refinedGroup, refinedLabels);
            const tierName = tolerance === 0 ? 'high' : 'medium';
            refinedGroup.name = `preview-${tierName}-${record.key}`;
            refinedLabels.name = `preview-labels-${tierName}-${record.key}`;
            const built = await buildPreviewChunk(record.features, refinedGroup, refinedLabels, tolerance, generation, refinedPickMeshes);
            if (generation !== previewBuildGeneration) {
              clearGroup(refinedGroup);
              clearGroup(refinedLabels);
              return;
            }
            record.refining = false;
            activeRecord = null;
            activeTemporaryGroups = [];
            if (built) {
              record.failureCount = 0;
              record.retryAfter = 0;
              // If the old refined tier is active, fall back to its coarse picker
              // before replacing it; the next RAF activates the new refined mesh.
              if (record.pickTier === 'refined') setChunkPickTier(record, 'coarse');
              if (record.refinedGroup) {
                buildingGroup.remove(record.refinedGroup);
                clearGroup(record.refinedGroup);
              }
              if (record.refinedLabels) {
                streetLabelGroup.remove(record.refinedLabels);
                clearGroup(record.refinedLabels);
              }
              record.refinedGroup = refinedGroup;
              record.refinedLabels = refinedLabels;
              record.refinedPickMeshes = refinedPickMeshes;
              record.refinedTolerance = tolerance;
              record.lastTouched = performance.now();
              buildingGroup.add(refinedGroup);
              streetLabelGroup.add(refinedLabels);
            } else {
              clearGroup(refinedGroup);
              clearGroup(refinedLabels);
            }

            // Refined chunks are admission-controlled; distant detailed meshes are
            // discarded above and regenerated only when the camera returns.
            const refined = [...previewChunks.values()].filter((item) => !!item.refinedGroup).length;
            setPreviewProgress((previous) => ({ ...previous, refined, total: previewChunks.size }));
            continue;
          }

          // Nothing else is currently within the camera's load/refinement range.
          break;
        }
      } catch (error) {
        activeTemporaryGroups.forEach((group) => clearGroup(group));
        if (activeRecord) {
          activeRecord.loading = false;
          activeRecord.refining = false;
          activeRecord.failureCount += 1;
          const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(5, activeRecord.failureCount - 1)));
          activeRecord.retryAfter = performance.now() + delayMs;
        }
        console.error('[SionnaRTStudio] Preview chunk build failed; will retry with backoff.', error);
      } finally {
        previewJobBusy = false;
        if (generation === previewBuildGeneration) {
          const refined = [...residentPreviewChunks].filter((record) => !!record.refinedGroup).length;
          setPreviewProgress((previous) => ({
            ...previous, loaded: loadedPreviewChunkCount, refined, total: previewChunks.size, streaming: false,
          }));
        }
      }
    }

    let lastPreviewVisibilityUpdate = 0;
    function updatePreviewLodVisibility(force = false) {
      const now = performance.now();
      // Only inspect resident GPU chunks, and update LOD at 8 Hz rather than
      // walking the entire city on every animation frame.
      if (!force && now - lastPreviewVisibilityUpdate < 125) return;
      lastPreviewVisibilityUpdate = now;
      for (const record of residentPreviewChunks) {
        if (!record.coarseGroup) continue;
        if (!previewLodEnabledRef.current) {
          // Full-detail preview: coarseGroup was rebuilt with tolerance=0. Keep it
          // visible and use its exact preview meshes for hit-testing.
          record.coarseGroup.visible = true;
          if (record.coarseLabels) record.coarseLabels.visible = true;
          if (record.refinedGroup) record.refinedGroup.visible = false;
          if (record.refinedLabels) record.refinedLabels.visible = false;
          setChunkPickTier(record, 'coarse');
          continue;
        }
        const distance = chunkCameraDistance(record);
        const wantsDetail = getDesiredPreviewTolerance(distance, record.refinedTolerance) !== null;
        const useRefined = wantsDetail && !!record.refinedGroup;
        record.coarseGroup.visible = !useRefined;
        if (record.coarseLabels) record.coarseLabels.visible = !useRefined;
        if (record.refinedGroup) record.refinedGroup.visible = useRefined;
        if (record.refinedLabels) record.refinedLabels.visible = useRefined;
        setChunkPickTier(record, useRefined ? 'refined' : 'coarse');
        if (useRefined) record.lastTouched = performance.now();
      }
    }

    // 7. NODE RENDERING (Tx and Rx panel tower model representations)
    function drawNodes3D() {
      clearGroup(transmitterGroup);
      clearGroup(receiverGroup);

      const current = stateRef.current;

      // Exact original OSM footprint lookup; preview LOD does not affect roof height.
      const rooftopZ = rooftopHeightAt;

      // Render every transmitter in the inventory, not only the active one.
      // These are preview markers; the RF solver consumes source TX data directly.
      const allTransmitters = current.txs?.length ? current.txs : [current.tx];
      const isLargeInventory = allTransmitters.length > 12;
      for (const item of allTransmitters) {
        const txEnuPos = { ...item.enu };
        const roofZ = rooftopZ(txEnuPos);
        const heightReference = item.heightReference ?? 'roof';
        const txBaseZ = heightReference === 'roof' ? roofZ : 0;
        const antennaZ = heightReference === 'agl' || heightReference === 'scene_z'
          ? item.height
          : roofZ + item.height;
        const mastHeight = Math.max(0.5, antennaZ - txBaseZ);
        const txThreePos = enuToThree({ ...txEnuPos, z: antennaZ });
        const isActive = item.id === (current.activeTxId ?? current.tx.id);

        const mastGeom = new THREE.CylinderGeometry(isActive ? 0.18 : 0.12, isActive ? 0.24 : 0.16, mastHeight, 6);
        const mastMat = new THREE.MeshStandardMaterial({
          color: isActive ? 0x334155 : 0x64748b,
          metalness: 0.65,
          roughness: 0.32,
        });
        const mast = new THREE.Mesh(mastGeom, mastMat);
        mast.position.set(txThreePos.x, txBaseZ + mastHeight / 2, txThreePos.z);
        mast.castShadow = true;
        transmitterGroup.add(mast);

        // Schematic sector panel oriented to imported azimuth; not a vendor pattern.
        const panelGeom = new THREE.BoxGeometry(isActive ? 1.2 : 0.85, isActive ? 3.2 : 2.5, 0.22);
        const panelMat = new THREE.MeshStandardMaterial({
          color: isActive ? 0xef4444 : 0xc47b55,
          metalness: 0.25,
          roughness: 0.55,
        });
        const panel = new THREE.Mesh(panelGeom, panelMat);
        panel.position.copy(txThreePos);
        const azimuthRad = ((Number(item.beamsteeringAzimuth) || 0) * Math.PI) / 180;
        const elevationRad = ((Number(item.beamsteeringElevation) || 0) * Math.PI) / 180;
        // In the Three.js ENU mapping, North is -Z and East is +X. The panel's
        // unrotated front normal is +Z (South), therefore yaw is PI - azimuth.
        // Positive mechanical/electrical downtilt corresponds to negative
        // beam elevation and a positive local X rotation.
        panel.rotation.order = 'YXZ';
        panel.rotation.y = Math.PI - azimuthRad;
        panel.rotation.x = -elevationRad;
        panel.castShadow = true;
        transmitterGroup.add(panel);

        const antennaGeom = new THREE.SphereGeometry(isActive ? 1.1 : 0.65, 10, 8);
        const antennaMat = new THREE.MeshBasicMaterial({ color: isActive ? 0xef4444 : 0xd97757 });
        const antennaMesh = new THREE.Mesh(antennaGeom, antennaMat);
        antennaMesh.position.copy(txThreePos);
        transmitterGroup.add(antennaMesh);

        // Limit labels in a large inventory to avoid canvas/texture clutter.
        if (!isLargeInventory || isActive) {
          const txLabel = makeLabelSprite(item.name, isActive ? '#d9aaa2' : '#9a765f');
          txLabel.position.set(txThreePos.x, txThreePos.y + (isActive ? 8 : 5), txThreePos.z);
          transmitterGroup.add(txLabel);
        }

        // Only the active sector gets the 3D boresight cone; every sector retains
        // its own azimuth and downtilt values for later RF solving/inspection.
        if (isActive) {
          const az = ((item.beamsteeringAzimuth || 0) * Math.PI) / 180;
          const el = ((item.beamsteeringElevation || 0) * Math.PI) / 180;
          const beamDir = new THREE.Vector3(
            Math.cos(el) * Math.sin(az),
            Math.sin(el),
            -Math.cos(el) * Math.cos(az),
          ).normalize();
          const beamLen = 28;
          const beamConeGeom = new THREE.ConeGeometry(8, beamLen, 16);
          const beamConeMat = new THREE.MeshBasicMaterial({
            color: 0xfca5a5,
            transparent: true,
            opacity: 0.42,
            wireframe: true,
          });
          const beamCone = new THREE.Mesh(beamConeGeom, beamConeMat);
          beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDir);
          beamCone.position.copy(txThreePos).add(beamDir.clone().multiplyScalar(beamLen / 2));
          transmitterGroup.add(beamCone);
        }
      }

      // Draw Receiver Terminal (RX). During mobility playback, use the selected
      // solved sample directly so animation does not mutate the editable Rx state.
      const rxEnuPos = current.activeMode === 'playback' && current.mobilityRxPosition
        ? { ...current.mobilityRxPosition, z: 0 }
        : { ...current.rx.enu };
      const rxBaseZ = rooftopZ(rxEnuPos);
      const rxHeight = current.activeMode === 'playback' && current.mobilityRxPosition
        ? current.mobilityRxPosition.z
        : rxBaseZ + current.rx.height;
      const rxThreePos = enuToThree({ ...rxEnuPos, z: rxHeight });

      // Clean glowing reception dome
      const deviceGeom = new THREE.SphereGeometry(1.2, 16, 16);
      const deviceMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6 });
      const deviceMesh = new THREE.Mesh(deviceGeom, deviceMat);
      deviceMesh.position.copy(rxThreePos);
      receiverGroup.add(deviceMesh);

      const devicePoleGeom = new THREE.CylinderGeometry(0.2, 0.2, rxHeight, 8);
      const devicePoleMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
      const devicePoleMesh = new THREE.Mesh(devicePoleGeom, devicePoleMat);
      devicePoleMesh.position.set(rxThreePos.x, rxHeight / 2, rxThreePos.z);
      receiverGroup.add(devicePoleMesh);

      // Name label (e.g. "Rx 1") floating above the active receiver.
      const rxLabel = makeLabelSprite(current.rx.name, '#a9c2c9');
      rxLabel.position.set(rxThreePos.x, rxThreePos.y + 6, rxThreePos.z);
      receiverGroup.add(rxLabel);

      // ── Markers for the OTHER (non-active) transmitters & receivers ───────
      // The active Tx/Rx already render above with full tower/device geometry;
      // here we add simpler poles+domes so every device in the list is visible.
      const drawMarker = (enu: ENUVector, height: number, color: number, name: string, labelColor: string) => {
        const baseZ = rooftopZ(enu);
        const top = enuToThree({ ...enu, z: baseZ + height });
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.3, baseZ + height, 8),
          new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6, roughness: 0.4 }),
        );
        pole.position.set(top.x, (baseZ + height) / 2, top.z);
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry(1.3, 16, 16),
          new THREE.MeshBasicMaterial({ color }),
        );
        dome.position.copy(top);
        const label = makeLabelSprite(name, labelColor);
        label.position.set(top.x, top.y + 6, top.z);
        return [pole, dome, label];
      };

      (current.txs ?? []).forEach((t) => {
        if (t.id === current.activeTxId) return; // active already drawn
        drawMarker(t.enu, t.height, 0xf87171, t.name, '#d9aaa2').forEach((m) => transmitterGroup.add(m)); // soft red
      });
      (current.rxs ?? []).forEach((r) => {
        if (r.id === current.activeRxId) return;
        drawMarker(r.enu, r.height, 0x60a5fa, r.name, '#a9c2c9').forEach((m) => receiverGroup.add(m)); // soft blue
      });
    }

    // 8. PROPAGATION RAY PATH LINES (LOS & bounces)
    function drawRayPaths3D() {
      clearGroup(pathsGroup);

      const current = stateRef.current;
      const allowRays =
        current.activeMode === 'link' ||
        current.activeMode === 'playback' ||
        (current.activeMode === 'heatmap' && current.showRaysOnHeatmap);
      if (!allowRays) return;

      // Playback shows its selected step. Link/heatmap can show all Tx/Rx pairs.
      const list = current.activeMode !== 'playback' && current.matrixPaths && current.matrixPaths.length > 0
        ? current.matrixPaths
        : current.paths;

      const positions: number[] = [];
      const colors: number[] = [];
      const markerPositions: THREE.Vector3[] = [];
      const markerColors: THREE.Color[] = [];

      list.forEach((path) => {
        if (!path.points || path.points.length < 2) return;
        const color = new THREE.Color(path.type === 'LOS' ? 0x22c55e : 0xf97316);
        const points = path.points.map(enuToThree);
        for (let index = 0; index < points.length - 1; index++) {
          const a = points[index];
          const b = points[index + 1];
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
          colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
          markerPositions.push(a);
          markerColors.push(color);
        }
      });

      if (positions.length > 0) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.computeBoundingSphere();
        const material = new THREE.LineBasicMaterial({
          color: 0xffffff,
          vertexColors: true,
          transparent: true,
          opacity: 0.9,
        });
        const segments = new THREE.LineSegments(geometry, material);
        segments.name = 'batched-propagation-paths';
        pathsGroup.add(segments);
      }

      // The small reflection/interaction markers use instancing: all markers
      // share one low-poly octahedron geometry and one material/draw call.
      if (markerPositions.length > 0) {
        const markerGeometry = new THREE.OctahedronGeometry(0.7, 1);
        const markerMaterial = new THREE.MeshBasicMaterial({ wireframe: true });
        const markers = new THREE.InstancedMesh(markerGeometry, markerMaterial, markerPositions.length);
        const dummy = new THREE.Object3D();
        markerPositions.forEach((position, index) => {
          dummy.position.copy(position);
          dummy.updateMatrix();
          markers.setMatrixAt(index, dummy.matrix);
          markers.setColorAt(index, markerColors[index]);
        });
        markers.instanceMatrix.needsUpdate = true;
        if (markers.instanceColor) markers.instanceColor.needsUpdate = true;
        markers.computeBoundingSphere();
        markers.name = 'instanced-propagation-interactions';
        pathsGroup.add(markers);
      }
    }

    // 9. DYNAMIC HEATMAP: Instanced colored grid squares for ultra performance
    function drawRadioMap3D() {
      const current = stateRef.current;
      const rm = current.radioMap;

      // A genuinely invalidated/cleared map releases its old GPU resources.
      // Merely changing the side-panel mode does not invalidate radioMap.
      if (!rm) {
        if (heatmapGroup.children.length > 0) clearGroup(heatmapGroup);
        heatmapGroup.visible = false;
        renderedHeatmapSnapshot = null;
        return;
      }

      const snapshot: HeatmapRenderSnapshot = {
        radioMap: rm,
        displayMode: current.radioMapDisplayMode,
        focusedCellIndex: current.focusedRadioMapCellIndex,
        colormap: current.rmColormap,
        autoRange: current.rmAutoRange,
        vmin: current.rmVmin,
        vmax: current.rmVmax,
      };

      // Link Analysis and Trajectory temporarily hide the radio-map layer.
      // Its instanced mesh and selected-cell marker remain in the scene so
      // returning to Radio Coverage restores the exact same view instantly.
      heatmapGroup.visible = current.activeMode === 'heatmap';
      if (!heatmapGroup.visible) return;

      const snapshotUnchanged = renderedHeatmapSnapshot !== null
        && renderedHeatmapSnapshot.radioMap === snapshot.radioMap
        && renderedHeatmapSnapshot.displayMode === snapshot.displayMode
        && renderedHeatmapSnapshot.focusedCellIndex === snapshot.focusedCellIndex
        && renderedHeatmapSnapshot.colormap === snapshot.colormap
        && renderedHeatmapSnapshot.autoRange === snapshot.autoRange
        && renderedHeatmapSnapshot.vmin === snapshot.vmin
        && renderedHeatmapSnapshot.vmax === snapshot.vmax;
      if (snapshotUnchanged && heatmapGroup.children.length > 0) return;

      // Rebuild only when map data or a map-display setting actually changes.
      clearGroup(heatmapGroup);
      const metric = rm.metric ?? 'power';
      const displayMode = current.radioMapDisplayMode ?? 'metric';
      const associationMode = displayMode !== 'metric';
      const size = rm.gridSize;

      // Association modes use categorical sector indices, not a continuous
      // colormap. They are pure visualization over the same physical radio map.
      type ValPt = { x: number; y: number; value: number; txIndex: number };
      const valid: ValPt[] = rm.cells
        .map((c) => {
          const association = displayMode === 'rss_association' ? c.servingTx
            : displayMode === 'sinr_association' ? c.bestSinrTx
              : displayMode === 'path_gain_association' ? c.bestPathGainTx
                : displayMode === 'top_interferer' ? c.topInterfererTx : null;
          const value = associationMode
            ? (association == null ? -1 : association)
            : metric === 'power' ? c.powerDbm
              : metric === 'sinr' ? (c.sinr ?? NaN)
                : (c.metricValue ?? NaN);
          return { x: c.x, y: c.y, value, txIndex: association == null ? -1 : association };
        })
        .filter((p) => associationMode || Number.isFinite(p.value));
      if (valid.length === 0) {
        renderedHeatmapSnapshot = snapshot;
        return;
      }

      let vmin = Infinity;
      let vmax = -Infinity;
      // Auto-normalize to this map's own min/max. Manual vmin/vmax only applies to
      // the received-power view (the sliders are calibrated in dBm).
      const autoStretch = !associationMode && (current.rmAutoRange || metric !== 'power');
      if (!associationMode && autoStretch) {
        for (const c of valid) {
          if (c.value < vmin) vmin = c.value;
          if (c.value > vmax) vmax = c.value;
        }
      } else if (!associationMode) {
        // Manual vmin/vmax, like sionna-rt-gui's radio map display sliders.
        vmin = Math.min(current.rmVmin, current.rmVmax);
        vmax = Math.max(current.rmVmin, current.rmVmax);
      }
      const span = vmax - vmin > 1e-6 ? vmax - vmin : 1;

      // Solid cell tiles that tile seamlessly (no gaps), flat on the ground.
      const cellGeom = new THREE.PlaneGeometry(size * 1.02, size * 1.02);
      cellGeom.rotateX(-Math.PI / 2);

      const cellMat = new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1.0,
      });

      const instMesh = new THREE.InstancedMesh(cellGeom, cellMat, valid.length);
      instMesh.renderOrder = 3; // draw cleanly over the ground grid
      const dummy = new THREE.Object3D();
      const tmp = new THREE.Color();
      const txIdByIndex = new Map<number, string>(
        (rm.txStats ?? []).map((stat) => [stat.txIndex, stat.txId] as const),
      );

      valid.forEach((cell, idx) => {
        // Sit just above the ground plane so the field reads as painted on it.
        const threePos = enuToThree({ x: cell.x, y: cell.y, z: 0.2 });
        dummy.position.copy(threePos);
        dummy.updateMatrix();
        instMesh.setMatrixAt(idx, dummy.matrix);

        if (associationMode) {
          if (cell.txIndex < 0) {
            tmp.setRGB(0.42, 0.44, 0.47); // unassociated / no detected interferer
          } else {
            const hue = getSectorHue(cell.txIndex, txIdByIndex.get(cell.txIndex));
            tmp.setHSL(hue, 0.68, 0.52);
          }
        } else {
          const t0 = (cell.value - vmin) / span;
          let t = t0;
          if (autoStretch) {
            // Auto mode: contrast stretch + brightening gamma so the upper range
            // pops. Manual vmin/vmax maps linearly, matching sionna-rt-gui.
            const CONTRAST = 1.7;
            t = (t0 - 0.5) * CONTRAST + 0.5;
            t = Math.min(1, Math.max(0, t));
            t = Math.pow(t, 0.78);
          } else {
            t = Math.min(1, Math.max(0, t));
          }
          colormapColor(current.rmColormap, t, tmp);
          if (autoStretch) {
            const hsl = { h: 0, s: 0, l: 0 };
            tmp.getHSL(hsl);
            tmp.setHSL(hsl.h, Math.min(1, hsl.s * 1.3), hsl.l);
          }
        }
        instMesh.setColorAt(idx, tmp);
      });

      instMesh.instanceColor!.needsUpdate = true;
      heatmapGroup.add(instMesh);

      // A selected weak cell is shown as a bright 3D pin and ground ring.
      // It is a visual locator only; it does not alter the ray-tracing scene.
      const focusedIndex = current.focusedRadioMapCellIndex;
      const focusedCell = focusedIndex == null ? null : rm.cells[focusedIndex];
      if (focusedCell) {
        const pinX = focusedCell.x;
        const pinZ = -focusedCell.y;
        const baseY = 0.72;
        const marker = new THREE.Group();
        marker.name = `focused-radio-map-cell-${focusedIndex}`;

        const ringGeometry = new THREE.RingGeometry(Math.max(1.2, size * 0.42), Math.max(2.0, size * 0.62), 40);
        ringGeometry.rotateX(-Math.PI / 2);
        const ringMaterial = new THREE.MeshBasicMaterial({
          color: 0xf59e0b, side: THREE.DoubleSide, transparent: true, opacity: 0.98,
          depthTest: false, depthWrite: false, toneMapped: false,
        });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        ring.position.set(pinX, baseY, pinZ);
        ring.renderOrder = 100;
        marker.add(ring);

        const stemGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(pinX, baseY, pinZ),
          new THREE.Vector3(pinX, baseY + 7, pinZ),
        ]);
        const stemMaterial = new THREE.LineBasicMaterial({ color: 0xb45309, depthTest: false, depthWrite: false, toneMapped: false });
        const stem = new THREE.Line(stemGeometry, stemMaterial);
        stem.renderOrder = 101;
        marker.add(stem);

        const pinGeometry = new THREE.SphereGeometry(1.5, 16, 12);
        const pinMaterial = new THREE.MeshBasicMaterial({ color: 0xfbbf24, depthTest: false, depthWrite: false, toneMapped: false });
        const pin = new THREE.Mesh(pinGeometry, pinMaterial);
        pin.position.set(pinX, baseY + 7, pinZ);
        pin.renderOrder = 102;
        marker.add(pin);
        heatmapGroup.add(marker);
      }

      renderedHeatmapSnapshot = snapshot;
    }


    function drawTrajectory3D() {
      clearGroup(trajectoryGroup);

      const current = stateRef.current;
      if (current.trajectoryPoints.length === 0) return;

      const pts = current.trajectoryPoints.map((p) => enuToThree({ ...p.enu, z: 0.35 }));
      if (pts.length >= 2) {
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.95 });
        const line = new THREE.Line(geom, mat);
        trajectoryGroup.add(line);
      }

      const markerGeometry = new THREE.SphereGeometry(1, 12, 12);
      const markerMaterial = new THREE.MeshBasicMaterial();
      const markers = new THREE.InstancedMesh(markerGeometry, markerMaterial, pts.length);
      const dummy = new THREE.Object3D();
      pts.forEach((pt, idx) => {
        const isEndpoint = idx === 0 || idx === pts.length - 1;
        const color = new THREE.Color(idx === 0 ? 0x10b981 : idx === pts.length - 1 ? 0xf27d26 : 0xe2e8f0);
        const radius = isEndpoint ? 1.1 : 0.75;
        dummy.position.copy(pt);
        dummy.scale.setScalar(radius);
        dummy.updateMatrix();
        markers.setMatrixAt(idx, dummy.matrix);
        markers.setColorAt(idx, color);
      });
      markers.instanceMatrix.needsUpdate = true;
      if (markers.instanceColor) markers.instanceColor.needsUpdate = true;
      markers.computeBoundingSphere();
      trajectoryGroup.add(markers);
    }

    // Field-measurement overlay: one point per unique GPS location. The point
    // height is a display-only offset because the GPS vertical datum is not
    // verified; horizontal ENU is recalculated from WGS84 and the live anchor.
    function drawMeasurementOverlay3D() {
      clearGroup(measurementGroup);
      measurementPointsCloud = null;
      measurementPointsCloudPoints = [];
      const current = stateRef.current;
      measurementGroup.visible = current.measurementOverlayVisible;
      if (!current.measurementOverlayVisible || current.measurementOverlayPoints.length === 0) return;

      const validPoints = current.measurementOverlayPoints.filter((point) =>
        Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
      if (validPoints.length === 0) return;

      const positions = new Float32Array(validPoints.length * 3);
      const colors = new Float32Array(validPoints.length * 3);
      const color = new THREE.Color();
      const displayHeightM = 1.6; // visual marker plane only; not GPS altitude / terrain snapping
      validPoints.forEach((point, index) => {
        const enu = latLonToENU(point.latitude, point.longitude, current.anchor);
        positions[index * 3] = enu.x;
        positions[index * 3 + 1] = displayHeightM;
        positions[index * 3 + 2] = -enu.y;
        // Weak RSRP = red, intermediate = amber, strong = green.
        if (point.rsrpDbm == null || !Number.isFinite(point.rsrpDbm)) {
          // QC-invalid/missing RSRP is intentionally shown, but never assigned
          // a misleading signal-strength colour.
          color.setHex(0x64748b);
        } else {
          const normalized = Math.max(0, Math.min(1, (point.rsrpDbm + 120) / 60));
          color.setHSL(0.02 + normalized * 0.31, 0.88, 0.48);
        }
        colors[index * 3] = color.r;
        colors[index * 3 + 1] = color.g;
        colors[index * 3 + 2] = color.b;
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();
      const material = new THREE.PointsMaterial({
        size: 9,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.96,
        depthTest: true,
        depthWrite: false,
      });
      measurementPointsCloud = new THREE.Points(geometry, material);
      measurementPointsCloudPoints = validPoints;
      measurementPointsCloud.name = 'field-measurement-gps-points';
      measurementPointsCloud.renderOrder = 25;
      measurementGroup.add(measurementPointsCloud);

      // Show a small screen-facing count badge for repeated source rows at one
      // GPS coordinate. The badge is a display annotation above the marker;
      // no latitude/longitude or solver coordinate is modified.
      const coordinateCounts = new Map<string, { point: MeasurementOverlayPoint; count: number }>();
      validPoints.forEach((point) => {
        const key = `${point.latitude.toFixed(7)}|${point.longitude.toFixed(7)}`;
        const existing = coordinateCounts.get(key);
        coordinateCounts.set(key, {
          point: existing?.point ?? point,
          count: (existing?.count ?? 0) + point.samples.length,
        });
      });
      coordinateCounts.forEach(({ point, count }) => {
        if (count < 2) return;
        const enu = latLonToENU(point.latitude, point.longitude, current.anchor);
        const badge = makeLabelSprite(`×${count}`, '#64748b');
        badge.scale.multiplyScalar(0.42);
        badge.position.set(enu.x, displayHeightM + 5, -enu.y);
        badge.name = `measurement-overlap-count-${count}`;
        measurementGroup.add(badge);
      });
    }

    // The GUI LOD switch rebuilds only disposable preview geometry. It never
    // changes the source OSM features or any backend/Sionna simulation input.
    previewLodRefreshRef.current = () => { void rebuildBuildings3D(); };

    // Initial build — the dynamic layers (nodes/rays/heatmap/trajectory) draw on
    // the first animation frame via the change watcher below.
    void rebuildBuildings3D();

    // 10. ANCHORED RAYCAST EVENT LISTENER (Snaps Tx / Rx precisely onto ground/roof points)
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function handleContainerClick(e: MouseEvent) {
      const current = stateRef.current;
      if (current.placementMode === 'none' && !(current.activeMode === 'playback' && current.pathDrawingMode)) return;

      // Calculate mouse canvas click coords
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      // Target buildings first for roof placement, fallback to ground slab
      const intersects = raycaster.intersectObjects([ground, ...buildingPickMeshes], true);

      if (intersects.length > 0) {
        const firstHit = intersects[0];
        const hitPt = firstHit.point;

        // Convert Three coordinate click back to ENU metrics
        // ENU.x = 3D.X
        // ENU.y = -3D.Z
        // Height calculated independently or bound to relative offset
        const east = hitPt.x;
        const north = -hitPt.z;

        if (current.activeMode === 'playback' && current.pathDrawingMode) {
          const enu = { x: east, y: north, z: 0 };
          const ll = enuToLatLon(enu, current.anchor);
          current.setTrajectoryPoints([
            ...current.trajectoryPoints,
            { lat: ll.lat, lon: ll.lon, enu },
          ]);
          return;
        }

        if (current.placementMode === 'tx') {
          const updatedTx: Transmitter = {
            ...current.tx,
            enu: { x: east, y: north, z: 0 }
          };
          current.onTxUpdate(updatedTx);
        } else if (current.placementMode === 'rx') {
          const updatedRx: Receiver = {
            ...current.rx,
            enu: { x: east, y: north, z: 0 }
          };
          current.onRxUpdate(updatedRx);
        }

        // Auto release action Mode picker
        current.setPlacementMode('none');
      }
    }

    let hoverFrameId = 0;
    let latestPointer: { clientX: number; clientY: number } | null = null;
    let lastHoverKey = '';

    function handleMouseMove(e: MouseEvent) {
      latestPointer = { clientX: e.clientX, clientY: e.clientY };
      if (hoverFrameId) return;
      hoverFrameId = requestAnimationFrame(() => {
        hoverFrameId = 0;
        const pointer = latestPointer;
        latestPointer = null;
        if (!pointer) return;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((pointer.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((pointer.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        // Let users inspect individual field measurements directly in 3D.
        // The raycaster threshold is converted from a small pixel radius to
        // world units so marker picking remains usable at different zooms.
        let nextMeasurements: MeasurementOverlayPoint[] = [];
        if (stateRef.current.measurementOverlayVisible && measurementPointsCloud) {
          const viewportHeight = Math.max(1, renderer.domElement.clientHeight || 580);
          const viewHeight = 2 * camera.position.distanceTo(controls.target) *
            Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
          raycaster.params.Points.threshold = Math.max(0.2, (viewHeight / viewportHeight) * 5);
          const pointHits = raycaster.intersectObject(measurementPointsCloud, false);
          const firstHitIndex = pointHits[0]?.index;
          const firstPoint = firstHitIndex == null ? null : measurementPointsCloudPoints[firstHitIndex] ?? null;
          if (firstPoint) {
            // Keep exact GPS coordinates untouched. When several records share
            // one coordinate, expose every coincident point in the inspector
            // instead of shifting markers horizontally and falsifying the map.
            const locationKey = `${firstPoint.latitude.toFixed(7)}|${firstPoint.longitude.toFixed(7)}`;
            const seen = new Set<string>();
            nextMeasurements = pointHits.flatMap((hit) => {
              const index = hit.index;
              if (index == null) return [];
              const point = measurementPointsCloudPoints[index];
              if (!point || `${point.latitude.toFixed(7)}|${point.longitude.toFixed(7)}` !== locationKey || seen.has(point.id)) return [];
              seen.add(point.id);
              return [point];
            });
          }
        }
        const nextMeasurementKey = nextMeasurements.map((point) => point.id).sort().join('|');
        setHoveredMeasurementPoints((previous) => previous.map((point) => point.id).sort().join('|') === nextMeasurementKey ? previous : nextMeasurements);

        const intersects = raycaster.intersectObjects([ground, ...buildingPickMeshes], true);

        let next: ENUVector | null = null;
        if (intersects.length > 0) {
          const hitPt = intersects[0].point;
          next = { x: hitPt.x, y: -hitPt.z, z: rooftopHeightAt({ x: hitPt.x, y: -hitPt.z }) };
        }
        // The HUD displays one decimal place; avoid scheduling React updates
        // for pointer jitter that cannot change the visible text.
        const nextKey = next
          ? `${next.x.toFixed(1)}:${next.y.toFixed(1)}:${next.z.toFixed(1)}`
          : '';
        if (nextKey !== lastHoverKey) {
          lastHoverKey = nextKey;
          setHoveredCoordinate(next);
        }
      });
    }

    renderer.domElement.addEventListener('click', handleContainerClick);
    renderer.domElement.addEventListener('mousemove', handleMouseMove);

    // 11. CENTRALIZED REALTIME ANIMATION DRAW LOOP
    let animationFrameId: number;
    let lastStatsTime = performance.now();
    let lastFrameTime = lastStatsTime;
    const frameIntervals: number[] = [];

    // Redraw each dynamic layer only when one of its inputs actually changed.
    // App state updates are immutable, so reference comparison is exact — no
    // string keys, no polling interval, no rebuild churn.
    type Snapshot = Partial<typeof stateRef.current>;
    let prev: Snapshot | null = null;

    const watchAndRedraw = () => {
      const c = stateRef.current;
      const first = prev === null;
      const p = prev ?? ({} as Snapshot);

      if (!first && c.showOutlines !== p.showOutlines) void rebuildBuildings3D();
      if (first || c.tx !== p.tx || c.rx !== p.rx || c.txs !== p.txs || c.rxs !== p.rxs ||
          c.activeTxId !== p.activeTxId || c.activeRxId !== p.activeRxId ||
          c.activeMode !== p.activeMode || c.mobilityRxPosition !== p.mobilityRxPosition ||
          c.showOutlines !== p.showOutlines) {
        drawNodes3D();
      }
      if (first || c.paths !== p.paths || c.matrixPaths !== p.matrixPaths ||
          c.activeMode !== p.activeMode || c.showRaysOnHeatmap !== p.showRaysOnHeatmap) {
        drawRayPaths3D();
      }
      if (first || c.radioMap !== p.radioMap || c.activeMode !== p.activeMode ||
          c.radioMapDisplayMode !== p.radioMapDisplayMode || c.rmColormap !== p.rmColormap || c.rmAutoRange !== p.rmAutoRange ||
          c.rmVmin !== p.rmVmin || c.rmVmax !== p.rmVmax) {
        drawRadioMap3D();
      }
      if ((first || c.focusedRadioMapCellIndex !== p.focusedRadioMapCellIndex) && c.focusedRadioMapCellIndex != null) {
        const focused = c.radioMap?.cells[c.focusedRadioMapCellIndex];
        if (focused) {
          const nextTarget = enuToThree({ x: focused.x, y: focused.y, z: 0.7 });
          const shift = nextTarget.clone().sub(controls.target);
          controls.target.copy(nextTarget);
          camera.position.add(shift);
        }
        drawRadioMap3D();
      } else if (!first && c.focusedRadioMapCellIndex !== p.focusedRadioMapCellIndex) {
        // Clearing the selection removes the locator without moving the camera.
        drawRadioMap3D();
      }
      if (first || c.trajectoryPoints !== p.trajectoryPoints) drawTrajectory3D();
      const overlayPointsChanged = first || c.measurementOverlayPoints !== p.measurementOverlayPoints;
      if (overlayPointsChanged || c.measurementOverlayVisible !== p.measurementOverlayVisible || c.anchor !== p.anchor) {
        drawMeasurementOverlay3D();
        // When a new route is loaded, frame it automatically so the user sees
        // the GPS locations immediately instead of having to search the scene.
        if (overlayPointsChanged && c.measurementOverlayVisible && c.measurementOverlayPoints.length > 0) {
          focusMeasurementOverlayRef.current?.();
        }
      }

      prev = { ...c };
    };

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      // Low-frequency instrumentation: sample RAF cadence and Three.js counters
      // once per second, never traverse the scene graph inside the render loop.
      const time = performance.now();
      const frameInterval = time - lastFrameTime;
      lastFrameTime = time;
      if (frameInterval > 0 && frameInterval < 1000) frameIntervals.push(frameInterval);
      watchAndRedraw();

      // Camera dynamic lock mode
      const current = stateRef.current;
      if (current.cameraMode === 'lockTx') {
        const txPos = enuToThree({ ...current.tx.enu, z: current.tx.height });
        controls.target.lerp(txPos, 0.1);
      }

      controls.update();
      updatePreviewLodVisibility();
      if (time >= lastPreviewJobTime + 350) {
        lastPreviewJobTime = time;
        void pumpPreviewJobs();
      }
      // Street names are map-scale decoration. Hide them when the camera is
      // zoomed far enough out that labels are unreadable, avoiding hundreds of
      // transparent-texture quads in a whole-city overview.
      streetLabelGroup.visible = camera.position.distanceTo(controls.target) < Math.max(1_800, previewExtent * 0.18);
      renderer.render(scene, camera);

      // Read renderer.info after render() so draw calls and triangle counts
      // belong to the frame that was just submitted.
      if (time >= lastStatsTime + 1000) {
        const sorted = [...frameIntervals].sort((a, b) => a - b);
        const p95 = sorted.length
          ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]
          : 0;
        const elapsed = Math.max(1, time - lastStatsTime);
        setRenderStats({
          fps: Math.round((frameIntervals.length * 1000) / elapsed),
          frameP95Ms: Number(p95.toFixed(1)),
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
        });
        frameIntervals.length = 0;
        lastStatsTime = time;
      }
    };

    animate();

    // Capture on demand without preserveDrawingBuffer (which would penalize
    // every frame). Re-render once, then encode the full backing canvas so a
    // Retina/HiDPI viewport exports at its native pixel resolution.
    captureScreenshotRef.current = () => {
      setScreenshotStatus('saving');
      controls.update();
      watchAndRedraw();
      renderer.render(scene, camera);
      renderer.domElement.toBlob((blob) => {
        if (!blob) {
          setScreenshotStatus('error');
          return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `sionna_rt_studio_scene_${timestamp}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Safari may consume the blob URL after the click handler returns.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setScreenshotStatus('saved');
        window.setTimeout(() => setScreenshotStatus('idle'), 1800);
      }, 'image/png');
    };

    // 12. DYNAMIC STATE WATCHERS
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight || 580;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(containerRef.current);

    focusMeasurementOverlayRef.current = () => {
      const current = stateRef.current;
      if (current.measurementOverlayPoints.length === 0) return;
      const enuPoints = current.measurementOverlayPoints.map((point) => latLonToENU(point.latitude, point.longitude, current.anchor));
      const eastMin = Math.min(...enuPoints.map((point) => point.x));
      const eastMax = Math.max(...enuPoints.map((point) => point.x));
      const northMin = Math.min(...enuPoints.map((point) => point.y));
      const northMax = Math.max(...enuPoints.map((point) => point.y));
      const centerEast = (eastMin + eastMax) / 2;
      const centerNorth = (northMin + northMax) / 2;
      const span = Math.max(80, eastMax - eastMin, northMax - northMin);
      const distance = Math.max(120, span * 1.35);
      const target = new THREE.Vector3(centerEast, 0, -centerNorth);
      controls.target.copy(target);
      camera.position.set(centerEast + distance * 0.9, distance * 0.78, -centerNorth + distance * 1.05);
      camera.lookAt(target);
      controls.update();
    };

    return () => {
      previewBuildGeneration++;
      captureScreenshotRef.current = null;
      focusMeasurementOverlayRef.current = null;
      previewLodRefreshRef.current = null;
      cancelAnimationFrame(animationFrameId);
      if (hoverFrameId) cancelAnimationFrame(hoverFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('click', handleContainerClick);
      renderer.domElement.removeEventListener('mousemove', handleMouseMove);
      controls.dispose();
      // Release every GPU resource this effect created.
      [buildingGroup, streetLabelGroup, transmitterGroup, receiverGroup, pathsGroup,
       heatmapGroup, trajectoryGroup, measurementGroup, interactionGroup].forEach(clearGroup);
      ground.geometry.dispose();
      groundMat.dispose();
      gridHelper.geometry.dispose();
      (gridHelper.material as THREE.Material).dispose();
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [buildings]);

  // Quality-mode changes update the existing WebGL renderer in place. The
  // previous implementation re-created the entire renderer and rebuilt every
  // OSM mesh when Eco/High was toggled, which becomes extremely expensive for
  // city-scale scenes. Simulation inputs are never touched here.
  useEffect(() => {
    const renderer = rendererRef.current;
    const container = containerRef.current;
    if (!renderer || !container) return;

    renderer.shadowMap.enabled = performanceMode === 'high';
    renderer.shadowMap.needsUpdate = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, performanceMode === 'high' ? 2 : 1));
    renderer.setSize(container.clientWidth, container.clientHeight || 580, false);
  }, [performanceMode]);


  return (
    <div id="three-studio-frame" className="relative flex-1 min-h-[420px] bg-slate-50 border border-slate-200 rounded overflow-hidden shadow-xl flex flex-col">
      {/* 3D Canvas rendering window */}
      <div ref={containerRef} className="w-full flex-1 relative min-h-[320px]">
        <canvas ref={canvasRef} id="canvas-3d" className="w-full h-full block" />

        {/* Floating coordinate helper & action HUD */}
        <div className="absolute top-4 left-4 bg-white/95 backdrop-blur-md shadow-lg rounded px-4 py-3.5 border border-slate-200 flex flex-col gap-1 text-slate-800 pointer-events-none z-10 transition-all max-w-xs">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#5f7f5a] animate-pulse" />
            <h4 className="eyebrow">3D PROPAGATION FIELD</h4>
          </div>
          <p className="text-[13px] text-slate-500 font-mono">
            {hoveredCoordinate
              ? `ENU m: E ${hoveredCoordinate.x.toFixed(1)}, N ${hoveredCoordinate.y.toFixed(1)}, Alt ${hoveredCoordinate.z.toFixed(1)}`
              : 'Hover to raycast coordinates'}
          </p>
          {(placementMode !== 'none' || (pathDrawingMode && activeMode === 'playback')) && (
            <div className="mt-2 text-[12px] py-1 px-2.5 bg-[#cc785c]/10 text-[#cc785c] animate-pulse rounded border border-[#cc785c]/30 font-semibold flex items-center gap-1.5">
              <Compass className="w-3.5 h-3.5 rotate-45" />
              <span>{pathDrawingMode && activeMode === 'playback' ? 'Click canvas to add path waypoint' : `Click canvas to place ${placementMode.toUpperCase()}`}</span>
            </div>
          )}
        </div>

        {measurementOverlayPoints.length > 0 && (
          <>
          <div className="absolute top-[112px] left-4 max-w-[360px] rounded-lg border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur-md z-10 pointer-events-auto text-slate-800">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-bold flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500"/>FIELD MEASUREMENTS</div>
              <span className="font-mono text-[10px] text-right">{measurementOverlayPoints.length.toLocaleString()} markera · {measurementOverlayPoints.reduce((sum, point) => sum + point.samples.length, 0).toLocaleString()} records</span>
            </div>
            <p className="mt-1 text-[10px] text-slate-500 break-words">{measurementOverlayLabel}</p>
            <div className="mt-2 h-2 rounded-full" style={{ background: 'linear-gradient(90deg, #dc2626 0%, #f59e0b 50%, #16a34a 100%)' }} />
            <div className="flex justify-between text-[9px] text-slate-500 font-mono"><span>Weak −120 dBm</span><span>Strong −60 dBm</span></div>
            <div className="mt-1 text-[9px] text-slate-500">Gray indicates invalid or missing RSRP</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => focusMeasurementOverlayRef.current?.()} className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold hover:bg-slate-50">Center route</button>
              <button type="button" onClick={() => setMeasurementOverlayVisible(!measurementOverlayVisible)} className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold hover:bg-slate-50">{measurementOverlayVisible ? 'Hide points' : 'Show points'}</button>
            </div>
            <p className="mt-2 text-[9px] text-amber-800">Marker height is a visual offset (1.6 m), not GPS altitude or a terrain/ground snap.</p>
          </div>
          {hoveredMeasurementPoints.length > 0 && measurementOverlayVisible && (() => {
            const primary = hoveredMeasurementPoints[0];
            const hoveredSamples = hoveredMeasurementPoints.flatMap((point) => point.samples);
            return (
              <div className="absolute top-[112px] right-4 max-w-[360px] w-[min(360px,calc(100%-2rem))] rounded-lg border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur-md z-10 pointer-events-none text-slate-800">
                <div className="text-xs font-bold">MEASUREMENT LOCATION</div>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                  <span className="text-slate-500">Coincident markers</span><strong className="font-mono">{hoveredMeasurementPoints.length}</strong>
                  <span className="text-slate-500">Original records</span><strong className="font-mono">{hoveredSamples.length}</strong>
                  <span className="text-slate-500">Latitude</span><strong className="font-mono">{primary.latitude.toFixed(7)}</strong>
                  <span className="text-slate-500">Longitude</span><strong className="font-mono">{primary.longitude.toFixed(7)}</strong>
                </div>
                <div className="mt-2 border-t border-slate-200 pt-2">
                  <div className="text-[10px] font-semibold mb-1">All readings at this GPS coordinate</div>
                  <div className="max-h-44 overflow-y-auto">
                    {hoveredSamples.map((sample, index) => (
                      <div key={`${sample.rowIndex}-${index}`} className="border-t border-slate-100 py-1.5 text-[9px]">
                        <div className="flex items-start justify-between gap-2"><strong>Row {sample.rowIndex + 1} · {sample.rat} / PCI {sample.pci ?? '—'}</strong><span className="font-mono whitespace-nowrap">{sample.timestampUtc && Number.isFinite(Date.parse(sample.timestampUtc)) ? new Date(sample.timestampUtc).toLocaleTimeString() : (sample.timestampUtc || 'No time')}</span></div>
                        <div className="mt-0.5 grid grid-cols-3 gap-2 font-mono text-slate-600">
                          <span>RSRP {sample.rsrpDbm == null ? '—' : `${sample.rsrpDbm.toFixed(1)} dBm`}</span>
                          <span>RSRQ {sample.rsrqDb == null ? '—' : `${sample.rsrqDb.toFixed(1)} dB`}</span>
                          <span>SINR {sample.sinrDb == null ? '—' : `${sample.sinrDb.toFixed(1)} dB`}</span>
                        </div>
                        {!sample.radioValid && <div className="text-amber-700 mt-0.5">QC: {sample.qualityFlags.join(', ') || 'invalid RSRP'}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
          </>
        )}

        {activeMode === 'heatmap' && radioMap && radioMapDisplayMode !== 'metric' && (
          <div className="absolute top-4 right-4 max-w-[240px] rounded border border-slate-200 bg-white/95 px-3 py-2 text-[10px] text-slate-700 shadow-md z-10 pointer-events-none">
            <div className="font-bold">Categorical sector association</div>
            <div className="mt-0.5 text-slate-500">Unique colours identify TX indices; grey cells have no associated TX in this layer. See the Sector table for names.</div>
            <div className="mt-1 font-mono">{radioMap.txStats?.length ?? 0} sectors in this run</div>
          </div>
        )}

        {/* Hovering Toolbar panel */}
        <div className="absolute bottom-4 left-4 right-4 flex flex-wrap justify-between items-center gap-3 bg-white/95 backdrop-blur-md border border-slate-200 p-2 rounded shadow-lg z-10 pointer-events-auto">
          {/* Quick Nodes Placement Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {activeMode === 'heatmap' && radioMap && (
              <label className="flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600">
                Radio-map view
                <select
                  aria-label="Radio map display mode"
                  value={radioMapDisplayMode}
                  onChange={(event) => setRadioMapDisplayMode(event.target.value as typeof radioMapDisplayMode)}
                  className="max-w-[155px] rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-800"
                >
                  <option value="metric">Continuous metric</option>
                  <option value="rss_association">RSS serving sector</option>
                  <option value="sinr_association">Best SINR sector</option>
                  <option value="path_gain_association">Best path-gain sector</option>
                  <option value="top_interferer">Dominant interferer</option>
                </select>
              </label>
            )}
            <button
              id="btn-place-tx"
              title="Click to place Transmitter antenna node over map"
              onClick={() => setPlacementMode(placementMode === 'tx' ? 'none' : 'tx')}
              className={cn(
                "px-3.5 py-1.5 text-[12px] font-bold rounded flex items-center gap-1.5  transition-all shadow-sm cursor-pointer border",
                placementMode === 'tx'
                  ? "bg-[#cc785c] text-white border-transparent scale-95"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#cc785c] animate-ping" />
              Place TX Antenna
            </button>

            <button
              id="btn-place-rx"
              title="Click to place Receiver device terminal node"
              onClick={() => setPlacementMode(placementMode === 'rx' ? 'none' : 'rx')}
              className={cn(
                "px-3.5 py-1.5 text-[12px] font-bold rounded flex items-center gap-1.5  transition-all shadow-sm cursor-pointer border",
                placementMode === 'rx'
                  ? "bg-[#4a727e] text-white border-transparent scale-95"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#6d939e] animate-pulse" />
              Place RX Device
            </button>

            <button
              id="btn-export-scene-screenshot"
              type="button"
              title="Download the current 3D scene view as a full-resolution PNG"
              onClick={() => captureScreenshotRef.current?.()}
              disabled={screenshotStatus === 'saving'}
              className={cn(
                "px-3.5 py-1.5 text-[12px] font-bold rounded flex items-center gap-1.5 transition-all shadow-sm cursor-pointer border",
                screenshotStatus === 'error'
                  ? "bg-red-50 text-red-700 border-red-300"
                  : screenshotStatus === 'saved'
                    ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900",
              )}
            >
              <Camera className="w-3.5 h-3.5" />
              {screenshotStatus === 'saving'
                ? 'Saving…'
                : screenshotStatus === 'saved'
                  ? 'PNG Saved'
                  : screenshotStatus === 'error'
                    ? 'Capture Failed'
                    : 'Screenshot'}
            </button>

            {activeMode === 'playback' && (
              <>
                <button
                  id="btn-draw-3d-mobility-path"
                  title="Click ground or rooftops in the 3D scene to add receiver trajectory waypoints"
                  onClick={() => setPathDrawingMode(!pathDrawingMode)}
                  className={cn(
                    "px-3.5 py-1.5 text-[12px] font-bold rounded flex items-center gap-1.5  transition-all shadow-sm cursor-pointer border",
                    pathDrawingMode
                      ? "bg-[#5f7f5a] text-white border-transparent scale-95"
                      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
                  )}
                >
                  Draw Path
                </button>
                <button
                  id="btn-undo-3d-mobility-path"
                  title="Remove the last receiver trajectory waypoint"
                  onClick={() => setTrajectoryPoints(trajectoryPoints.slice(0, -1))}
                  disabled={trajectoryPoints.length === 0}
                  className="px-3.5 py-1.5 text-[12px] font-bold rounded transition shadow-sm cursor-pointer border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 disabled:text-slate-300 disabled:bg-slate-100"
                >
                  Undo
                </button>
                <button
                  id="btn-clear-3d-mobility-path"
                  title="Clear receiver trajectory waypoints"
                  onClick={() => setTrajectoryPoints([])}
                  disabled={trajectoryPoints.length === 0}
                  className="px-3.5 py-1.5 text-[12px] font-bold rounded transition shadow-sm cursor-pointer border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 disabled:text-slate-300 disabled:bg-slate-100"
                >
                  Clear
                </button>
              </>
            )}
          </div>

          {/* Aesthetic Controls */}
          <div className="flex items-center gap-1">
            <button
              title="Blueprint outlines toggle"
              onClick={() => setShowOutlines(!showOutlines)}
              className={cn(
                "p-1.5 border hover:text-slate-900 hover:bg-slate-50 rounded duration-150 cursor-pointer text-[12px] font-bold ",
                showOutlines ? "border-[#cc785c]/40 bg-[#cc785c]/10 text-[#cc785c]" : "border-slate-200 bg-white text-slate-600"
              )}
            >
              Outlines
            </button>

            <button
              title="Camera steering tracking toggle"
              onClick={() => setCameraMode(cameraMode === 'orbit' ? 'lockTx' : 'orbit')}
              className={cn(
                "p-1.5 border hover:text-slate-900 hover:bg-slate-50 rounded duration-150 cursor-pointer flex items-center gap-1 text-[12px] font-bold ",
                cameraMode === 'lockTx' ? "border-[#cc785c]/40 bg-[#cc785c]/10 text-[#cc785c]" : "border-slate-200 bg-white text-slate-600"
              )}
            >
              <Compass className={cn("w-3.5 h-3.5", cameraMode === 'lockTx' && "animate-spin")} />
              {cameraMode === 'lockTx' ? 'Target: TX' : 'Free Camera'}
            </button>

            <button
              id="btn-preview-lod-toggle"
              type="button"
              aria-pressed={previewLodEnabled}
              title={previewLodEnabled
                ? 'LOD is on: distant preview geometry is simplified. Turn off for full-detail screenshots. Chunk streaming remains active.'
                : 'Full-detail preview: geometric simplification is off for loaded chunks. Chunk streaming remains active; memory use can increase.'}
              onClick={() => {
                const nextEnabled = !previewLodEnabledRef.current;
                previewLodEnabledRef.current = nextEnabled;
                setPreviewLodEnabled(nextEnabled);
                previewLodRefreshRef.current?.();
              }}
              className={cn(
                'p-1.5 border rounded cursor-pointer shadow-sm text-[12px] font-bold transition-colors',
                previewLodEnabled
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                  : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
              )}
            >
              {previewLodEnabled ? 'LOD On' : 'Full Detail'}
            </button>

            <button
              title="Toggle preview rendering quality; Eco disables shadow mapping and caps device pixel ratio at 1. This is independent of LOD."
              onClick={() => setPerformanceMode(performanceMode === 'high' ? 'eco' : 'high')}
              className="p-1.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900 rounded cursor-pointer shadow-sm text-[12px] font-bold"
            >
              {performanceMode === 'high' ? '🔋 High' : '🔋 Eco'}
            </button>
          </div>
        </div>

        {/* Tiny live frame stats tag */}
        <div className="absolute top-4 right-4 bg-white/95 border border-slate-200 backdrop-blur-md rounded px-2.5 py-1 text-[12px] text-slate-600 font-mono shadow-sm flex items-center gap-1.5 z-10 select-none">
          <Activity className="w-3 h-3 text-[#5f7f5a]" />
          <span>{renderStats.fps} FPS</span>
          <span className="text-slate-400">|</span>
          <span>P95 {renderStats.frameP95Ms} ms</span>
          <span className="text-slate-400">|</span>
          <span>DC {renderStats.drawCalls}</span>
          <span className="text-slate-400">|</span>
          <span>△ {renderStats.triangles.toLocaleString()}</span>
          <span className="text-slate-400">|</span>
          <span>G {renderStats.geometries}/T {renderStats.textures}</span>
          <span className="text-slate-400">|</span>
          <span title={previewLodEnabled ? 'Distance-based preview LOD is enabled' : 'Full-detail preview is enabled; chunk streaming remains active'}>
            {previewLodEnabled ? 'LOD ON' : 'FULL'}
          </span>
          {previewProgress.total > 0 && (
            <>
              <span className="text-slate-400">|</span>
              <span title="Preview chunks loaded / total; LOD count is shown only when distance-based LOD is enabled">
                C {previewProgress.loaded}/{previewProgress.total} · {previewLodEnabled ? `LOD ${previewProgress.refined}` : 'Full detail'}
              </span>
              {previewProgress.streaming && <span className="text-emerald-600">Loading</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
