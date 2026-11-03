// Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
// Upstream: https://github.com/puloktarafder/SionnaRTStudio

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { BookOpen } from 'lucide-react';
import { GeoAnchor, Transmitter, Receiver, BuildingFootprint, PropagationPath, RadioMapGrid, ChannelMetrics, MatrixCell, SolverOptions, DEFAULT_SOLVER_OPTIONS, MaterialConfig, CoverageMetric, MobilityCombineMode, defaultMaterialConfig, MeasurementOverlayPoint } from './types';
import { ColormapName } from './lib/colormaps';
import { ThreeStudio } from './components/ThreeStudio';
import { TopNav } from './components/TopNav';
import { MapSelector } from './components/MapSelector';
import { SolverControls } from './components/SolverControls';
import { LinkPanel } from './components/LinkPanel';
import { CoveragePanel } from './components/CoveragePanel';
import { TrajectoryPanel } from './components/TrajectoryPanel';
import { GeographyPanel } from './components/GeographyPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ExportPanel } from './components/ExportPanel';
import { FieldValidationPanel } from './components/FieldValidationPanel';
import { ExperimentPanel } from './components/ExperimentPanel';
import { BaseStationImportPanel } from './components/BaseStationImportPanel';
import {
  latLonToENU,
  enuToLatLon,
  fetchOSMBuildings,
} from './utils';
import { createSolveContextKey, enuPositionChanged } from './lib/solveContext';
import { solveLink, solveRadioMap, solveMobility, checkBackend, MobilityExecution, MobilityStep, HandoverAnalysis, HandoverConfig, ExperimentRun, createExperimentRecord, getPhyBerStatus, getMeasurementRayTraceJob } from './api';
import { safeCreateExperiment, safeUpdateExperiment, sha256Json, summarizeUnknownExperimentResult, summarizeMeasurementRayTrace } from './lib/experimentLogging';
import {
  clearAutosavedProject,
  loadAutosavedProject,
  parseProjectDocument,
  saveAutosavedProject,
  StudioProjectState,
} from './project';

const EMPTY_METRICS: ChannelMetrics = {
  totalRxPowerDbm: -200,
  losStatus: 'NLOS',
  numPaths: 0,
  rmsDelaySpreadNs: 0,
  rmsDelaySpreadValid: true,
  strongestPathPowerDbm: -200,
  strongestPathType: 'None',
};

const metricsFromMobilityStep = (step: MobilityStep): ChannelMetrics => {
  const strongestPath = step.paths[0];

  return {
    totalRxPowerDbm: step.receivedPowerDbm,
    losStatus: step.losStatus,
    numPaths: step.numPaths,
    rmsDelaySpreadNs: step.rmsDelaySpreadNs,
    rmsDelaySpreadValid: step.rmsDelaySpreadValid,
    strongestPathPowerDbm: strongestPath?.receivedPowerDbm ?? -200,
    strongestPathType: strongestPath?.type ?? 'None',
  };
};

const INITIAL_ANCHOR: GeoAnchor = {
  latitude: 38.9226,
  longitude: -77.0194, // Howard University, Washington DC
};

// Lightweight procedural starter scene; replace it with live OSM features for
// site-specific studies.
const PRELOADED_BUILDINGS: BuildingFootprint[] = [
  {
    id: 'pre_skyscraper_1',
    points: [],
    enuPoints: [
      { x: -60, y: -70, z: 0 },
      { x: -10, y: -70, z: 0 },
      { x: -10, y: -20, z: 0 },
      { x: -60, y: -20, z: 0 },
    ],
    height: 46.0,
    category: 'building',
    type: 'commercial',
    material: 'itu_glass',
  },
  {
    id: 'pre_office_2',
    points: [],
    enuPoints: [
      { x: 45, y: -80, z: 0 },
      { x: 95, y: -80, z: 0 },
      { x: 95, y: -30, z: 0 },
      { x: 45, y: -30, z: 0 },
    ],
    height: 26.5,
    category: 'building',
    type: 'office',
    material: 'itu_concrete',
  },
  {
    id: 'pre_apartment_3',
    points: [],
    enuPoints: [
      { x: -90, y: 35, z: 0 },
      { x: -40, y: 35, z: 0 },
      { x: -40, y: 85, z: 0 },
      { x: -90, y: 85, z: 0 },
    ],
    height: 18.0,
    category: 'building',
    type: 'apartments',
    material: 'itu_brick',
  },
  {
    id: 'pre_skytower_4',
    points: [],
    enuPoints: [
      { x: 40, y: 40, z: 0 },
      { x: 90, y: 40, z: 0 },
      { x: 90, y: 90, z: 0 },
      { x: 40, y: 90, z: 0 },
    ],
    height: 54.0,
    category: 'building',
    type: 'office',
    material: 'itu_glass',
  },
  {
    id: 'pre_road_major_1',
    points: [],
    enuPoints: [
      { x: -200, y: -5, z: 0 },
      { x: 200, y: -5, z: 0 },
    ],
    height: 0.1,
    category: 'infrastructure',
    type: 'primary',
    material: 'itu_dry_ground',
  },
  {
    id: 'pre_road_major_2',
    points: [],
    enuPoints: [
      { x: -5, y: -200, z: 0 },
      { x: -5, y: 200, z: 0 },
    ],
    height: 0.1,
    category: 'infrastructure',
    type: 'primary',
    material: 'itu_dry_ground',
  },
  {
    id: 'pre_park_green_1',
    points: [],
    enuPoints: [
      { x: -180, y: 15, z: 0 },
      { x: -110, y: 15, z: 0 },
      { x: -110, y: 85, z: 0 },
      { x: -180, y: 85, z: 0 },
    ],
    height: 0.05,
    category: 'terrain',
    type: 'park',
    material: 'itu_dry_ground',
  },
  {
    id: 'pre_park_green_2',
    points: [],
    enuPoints: [
      { x: 110, y: -180, z: 0 },
      { x: 180, y: -180, z: 0 },
      { x: 180, y: -110, z: 0 },
      { x: 110, y: -110, z: 0 },
    ],
    height: 0.05,
    category: 'terrain',
    type: 'grass',
    material: 'itu_dry_ground',
  },
];

const AUTOSAVED_PROJECT = loadAutosavedProject()?.state ?? null;

export default function App() {
  const [anchor, setAnchor] = useState<GeoAnchor>(
    () => AUTOSAVED_PROJECT?.scene.anchor ?? INITIAL_ANCHOR,
  );

  // ── Multiple transmitters & receivers ───────────────────────────────────
  // The arrays hold every device; `activeTxId`/`activeRxId` mark the one the
  // sliders, map drag and 3D drag currently edit. `tx`/`rx` below are derived
  // from those, so all single-device UI keeps working on the active device.
  const [txs, setTxs] = useState<Transmitter[]>(() => AUTOSAVED_PROJECT?.devices.transmitters ?? [
    {
      id: 'tx_1',
      name: 'Tx 1',
      latitude: INITIAL_ANCHOR.latitude + 0.0003,
      longitude: INITIAL_ANCHOR.longitude - 0.0004,
      height: 12.0,
      enu: { x: -40, y: 40, z: 0 },
      powerDbm: 30,
      antennaArraySize: [8, 8],
      beamsteeringAzimuth: 145,
      beamsteeringElevation: 5,
    },
  ]);
  const [rxs, setRxs] = useState<Receiver[]>(() => AUTOSAVED_PROJECT?.devices.receivers ?? [
    {
      id: 'rx_1',
      name: 'Rx 1',
      latitude: INITIAL_ANCHOR.latitude - 0.0003,
      longitude: INITIAL_ANCHOR.longitude + 0.0004,
      height: 1.5,
      enu: { x: 40, y: -40, z: 0 },
      antennaArraySize: [1, 1],
    },
  ]);
  const [activeTxId, setActiveTxId] = useState(
    () => AUTOSAVED_PROJECT?.devices.activeTxId ?? 'tx_1',
  );
  const [activeRxId, setActiveRxId] = useState(
    () => AUTOSAVED_PROJECT?.devices.activeRxId ?? 'rx_1',
  );

  const tx = txs.find((t) => t.id === activeTxId) ?? txs[0];
  const rx = rxs.find((r) => r.id === activeRxId) ?? rxs[0];

  const [buildings, setBuildings] = useState<BuildingFootprint[]>(
    () => AUTOSAVED_PROJECT?.scene.buildings ?? PRELOADED_BUILDINGS,
  );
  const [freqGhz, setFreqGhz] = useState(
    () => AUTOSAVED_PROJECT?.solver.carrierFrequencyGhz ?? 28.0,
  ); // Default to mmWave
  // Imported inventory can span multiple RAT/bands. RadioMapSolver uses one
  // scene carrier frequency, so cross-band transmitters must never be solved as
  // if they interfered on the same carrier.
  const [coverageBandFilter, setCoverageBandFilter] = useState('__all__');
  const [confirmedCarrierBand, setConfirmedCarrierBand] = useState<string | null>(null);
  const coverageBandOptions = React.useMemo(
    () => Array.from(new Set(txs.map((item) => item.frequencyBand).filter((band): band is string => Boolean(band)))).sort(),
    [txs],
  );
  const coverageTxs = React.useMemo(() => {
    if (coverageBandFilter === '__all__') return txs;
    return txs.filter((item) => item.frequencyBand === coverageBandFilter);
  }, [txs, coverageBandFilter]);
  const [maxDepth, setMaxDepth] = useState(
    () => AUTOSAVED_PROJECT?.solver.maxDepth ?? 3,
  ); // Sionna RT max interaction depth

  // Ray-interaction switches + Tx antenna pattern/polarization (sionna-rt-gui style).
  const [solverOptions, setSolverOptions] = useState<SolverOptions>(
    () => AUTOSAVED_PROJECT?.solver.options ?? DEFAULT_SOLVER_OPTIONS,
  );

  // Radio map display (colormap + manual range), like sionna-rt-gui's map panel.
  const [rmColormap, setRmColormap] = useState<ColormapName>(
    () => AUTOSAVED_PROJECT?.display.radioMapColormap ?? 'viridis',
  );
  const [rmAutoRange, setRmAutoRange] = useState(
    () => AUTOSAVED_PROJECT?.display.radioMapAutoRange ?? true,
  );
  const [rmVmin, setRmVmin] = useState(
    () => AUTOSAVED_PROJECT?.display.radioMapVmin ?? -120,
  );
  const [rmVmax, setRmVmax] = useState(
    () => AUTOSAVED_PROJECT?.display.radioMapVmax ?? -50,
  );

  // Top navigation view (3D SCENE / GEOGRAPHY / ANALYSIS / EXPORT)
  const [activeNavTab, setActiveNavTab] = useState<'3d_scene' | 'geography' | 'analysis' | 'field_validation' | 'experiments' | 'export'>(
    () => AUTOSAVED_PROJECT?.display.activeNavTab ?? '3d_scene',
  );

  // Georeferenced field measurements are lifted to App state so they remain
  // visible when navigating from Field Validation back to the 3D scene.
  const [measurementOverlayPoints, setMeasurementOverlayPoints] = useState<MeasurementOverlayPoint[]>([]);
  const [measurementOverlayLabel, setMeasurementOverlayLabel] = useState('');
  const [measurementOverlayVisible, setMeasurementOverlayVisible] = useState(true);
  const showMeasurementOverlayIn3D = (points: MeasurementOverlayPoint[], label: string) => {
    setMeasurementOverlayPoints(points);
    setMeasurementOverlayLabel(label);
    setMeasurementOverlayVisible(true);
    setActiveNavTab('3d_scene');
  };
  const clearMeasurementOverlay = () => {
    setMeasurementOverlayPoints([]);
    setMeasurementOverlayLabel('');
    setMeasurementOverlayVisible(false);
  };

  // Active Studio Modes
  const [activeMode, setActiveMode] = useState<'link' | 'heatmap' | 'playback'>(
    () => AUTOSAVED_PROJECT?.display.activeMode ?? 'link',
  );
  const [placementMode, setPlacementMode] = useState<'none' | 'tx' | 'rx'>('none');
  const [showOutlines, setShowOutlines] = useState(
    () => AUTOSAVED_PROJECT?.display.showOutlines ?? true,
  );
  const [showRaysOnHeatmap, setShowRaysOnHeatmap] = useState(
    () => AUTOSAVED_PROJECT?.display.showRaysOnHeatmap ?? false,
  ); // overlay rays on coverage

  // Coverage Map State
  const [radioMap, setRadioMap] = useState<RadioMapGrid | null>(null);
  const [focusedRadioMapCellIndex, setFocusedRadioMapCellIndex] = useState<number | null>(null);
  useEffect(() => {
    setFocusedRadioMapCellIndex(null);
  }, [radioMap?.mapId]);
  const [loadingHeatmap, setLoadingHeatmap] = useState(false);
  // Interference-aware coverage controls (Sionna RadioMapSolver rss/sinr).
  const [coverageMetric, setCoverageMetric] = useState<CoverageMetric>(
    () => AUTOSAVED_PROJECT?.coverage.metric ?? 'power',
  );
  const [coverageThresholdDb, setCoverageThresholdDb] = useState(-90);
  const handleCoverageMetricChange = (metric: CoverageMetric) => {
    setCoverageMetric(metric);
    const defaults: Record<CoverageMetric, number> = {
      power: -90, path_gain: -110, path_loss: 110, sinr: 0, best_sinr: 0, interference: -100, sir: 0, inr: -10, dominance: 6,
    };
    setCoverageThresholdDb(defaults[metric]);
  };
  const [coverageBandwidthMhz, setCoverageBandwidthMhz] = useState(
    () => AUTOSAVED_PROJECT?.coverage.bandwidthMhz ?? 100,
  );
  const [coverageNoiseFigureDb, setCoverageNoiseFigureDb] = useState(
    () => AUTOSAVED_PROJECT?.coverage.noiseFigureDb ?? 7,
  );
  const [coverageHeight, setCoverageHeight] = useState(
    () => AUTOSAVED_PROJECT?.coverage.heightM ?? 1.5,
  );
  const [coverageRes, setCoverageRes] = useState(
    () => AUTOSAVED_PROJECT?.coverage.gridStepM ?? 8,
  );
  const [coverageSamplesPerTx, setCoverageSamplesPerTx] = useState(
    () => AUTOSAVED_PROJECT?.coverage.samplesPerTx ?? 1_000_000,
  );
  const [radioMapSeed, setRadioMapSeed] = useState(
    () => AUTOSAVED_PROJECT?.coverage.seed ?? 42,
  );

  // Per-material scattering / EM overrides, keyed by material id, sent with solves.
  const [materialConfigs, setMaterialConfigs] = useState<Record<string, MaterialConfig>>(
    () => AUTOSAVED_PROJECT?.solver.materialConfigs ?? {},
  );
  const materialIds = React.useMemo(
    () => Array.from(new Set(buildings.filter((b) => b.category === 'building').map((b) => b.material))),
    [buildings],
  );
  const materialList = React.useMemo<MaterialConfig[]>(
    () => materialIds.map((id) => materialConfigs[id] ?? defaultMaterialConfig(id)),
    [materialIds, materialConfigs],
  );
  const updateMaterial = (cfg: MaterialConfig) =>
    setMaterialConfigs((prev) => ({ ...prev, [cfg.id]: cfg }));

  // GIS Data Fetcher States
  const [gisLoading, setGisLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('');

  // Trajectory points state
  const [trajectoryPoints, setTrajectoryPoints] = useState<
    { lat: number; lon: number; enu: { x: number; y: number; z: number } }[]
  >(() => AUTOSAVED_PROJECT?.mobility.trajectoryPoints ?? []);
  const [activeMobilityStep, setActiveMobilityStep] = useState<MobilityStep | null>(null);

  // Synchronize active Transmitter Lat/Lon ↔ ENU. Changing the active device
  // (including clicking a cell in the solved Tx × Rx matrix) is a selection
  // operation, not a geometry edit. Skip the conversion on selection changes;
  // device-edit handlers already keep the geographic and ENU coordinates in
  // sync. The epsilon guard also avoids invalidation from round-trip noise.
  const previousTxSelectionRef = useRef(activeTxId);
  useEffect(() => {
    const selectionChanged = previousTxSelectionRef.current !== activeTxId;
    previousTxSelectionRef.current = activeTxId;
    if (selectionChanged) return;

    const enu = latLonToENU(tx.latitude, tx.longitude, anchor);
    setTxs((prev) => {
      const current = prev.find((item) => item.id === activeTxId);
      if (!current || !enuPositionChanged(current.enu, enu)) return prev;
      return prev.map((item) => (item.id === activeTxId ? { ...item, enu } : item));
    });
  }, [tx.latitude, tx.longitude, anchor, activeTxId]);

  // Same rule for receivers: selecting another RX must not mutate device
  // geometry and consequently clear previously solved all-pairs results.
  const previousRxSelectionRef = useRef(activeRxId);
  useEffect(() => {
    const selectionChanged = previousRxSelectionRef.current !== activeRxId;
    previousRxSelectionRef.current = activeRxId;
    if (selectionChanged) return;

    const enu = latLonToENU(rx.latitude, rx.longitude, anchor);
    setRxs((prev) => {
      const current = prev.find((item) => item.id === activeRxId);
      if (!current || !enuPositionChanged(current.enu, enu)) return prev;
      return prev.map((item) => (item.id === activeRxId ? { ...item, enu } : item));
    });
  }, [rx.latitude, rx.longitude, anchor, activeRxId]);

  // PROPAGATION LINK PHYSICS SOLVER — real Sionna RT on the backend, run on demand.
  const [paths, setPaths] = useState<PropagationPath[]>([]);
  const [metrics, setMetrics] = useState<ChannelMetrics>(EMPTY_METRICS);
  const [solving, setSolving] = useState(false);
  const [solveError, setSolveError] = useState<string>('');
  const [backendOnline, setBackendOnline] = useState(false);
  const backendOnlineRef = useRef(backendOnline);
  backendOnlineRef.current = backendOnline;

  // Probe the backend on mount, then keep polling while it's offline so the
  // solve buttons recover when the backend is started after the frontend.
  useEffect(() => {
    let cancelled = false;
    const probe = () => checkBackend().then((ok) => { if (!cancelled) setBackendOnline(ok); });
    probe();
    const id = window.setInterval(() => {
      if (!backendOnlineRef.current) probe();
    }, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  // All-pairs link matrix (Tx × Rx), keyed `${txId}|${rxId}`.
  const [matrix, setMatrix] = useState<Record<string, MatrixCell>>({});
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixProgress, setMatrixProgress] = useState('');
  // Whether the 3D scene overlays ALL matrix rays. True right after Solve All
  // Pairs; false once the user focuses a single pair (cell click / Solve Link),
  // so a fresh single-link solve isn't drowned out by every pair's rays.
  const [matrixRaysVisible, setMatrixRaysVisible] = useState(false);

  const [sceneGeometryFingerprint, setSceneGeometryFingerprint] = useState('');
  useEffect(() => {
    let active = true;
    void sha256Json({ anchor, buildings }).then((fingerprint) => {
      if (active) setSceneGeometryFingerprint(fingerprint);
    }).catch(() => { if (active) setSceneGeometryFingerprint(''); });
    return () => { active = false; };
  }, [anchor, buildings]);

  // Invalidate cached solve outputs only when physical solve inputs change.
  // The selected TX/RX IDs are deliberately NOT dependencies: selecting a
  // solved matrix cell must retain the matrix and simply focus its link paths.
  // A canonical key also protects against harmless React object identity changes.
  const solveContextKey = React.useMemo(
    () => createSolveContextKey({ buildings, txs, rxs, freqGhz, maxDepth, solverOptions, materialConfigs }),
    [buildings, txs, rxs, freqGhz, maxDepth, solverOptions, materialConfigs],
  );

  useEffect(() => {
    setPaths([]);
    setMetrics(EMPTY_METRICS);
    setMatrix({});
    setRadioMap(null);
    setMobilitySteps([]);
    setActiveMobilityStep(null);
  }, [solveContextKey]);

  const handleSolve = async () => {
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    const requestBody = { tx, rx, buildings, freqGhz, maxDepth, options: solverOptions, materials: materialList };
    const configuration = { tx, rx, freqGhz, maxDepth, solverOptions, materials: materialList, scene: { anchor, buildingCount: buildings.length, geometryFingerprint: sceneGeometryFingerprint } };
    let status: 'done' | 'error' = 'done';
    let resultSummary: Record<string, unknown> = {};
    let errorText: string | null = null;
    setSolving(true);
    setSolveError('');
    try {
      const res = await solveLink(tx, rx, buildings, freqGhz, maxDepth, solverOptions, materialList);
      setPaths(res.paths);
      setMetrics(res.metrics);
      setMatrixRaysVisible(false); // focus the 3D scene on this single link
      setBackendOnline(true);
      resultSummary = summarizeUnknownExperimentResult('link_solve', res);
    } catch (e: any) {
      status = 'error';
      errorText = e?.message || 'Solve failed';
      setSolveError(errorText);
      checkBackend().then(setBackendOnline); // a solve error != backend offline
    } finally {
      setSolving(false);
      await safeCreateExperiment({
        name: `Link solve · ${tx.name} → ${rx.name}`, kind: 'link_solve', status,
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        seed: solverOptions.pathSeed, configuration,
        parameters: { txId: tx.id, rxId: rx.id, freqGhz, maxDepth, pathSamplesPerSource: solverOptions.pathSamplesPerSource, seed: solverOptions.pathSeed, buildingCount: buildings.length },
        results: resultSummary, error: errorText,
        replay: { endpoint: '/api/solve', body: requestBody, description: 'Repeat the exact single-link PathSolver request' },
      });
    }
  };

  // Solve every Tx → Rx pair (serial GPU ray traces, scene is cached).
  const handleSolveMatrix = async () => {
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    const next: Record<string, MatrixCell> = {};
    const total = txs.length * rxs.length;
    let done = 0;
    let status: 'done' | 'error' = 'done';
    let errorText: string | null = null;
    setMatrixLoading(true);
    setSolveError('');
    try {
      for (const t of txs) {
        for (const r of rxs) {
          done += 1;
          setMatrixProgress(`${t.name} → ${r.name}  (${done}/${total})`);
          const res = await solveLink(t, r, buildings, freqGhz, maxDepth, solverOptions, materialList);
          next[`${t.id}|${r.id}`] = { txId: t.id, rxId: r.id, metrics: res.metrics, paths: res.paths };
        }
      }
      setMatrix(next);
      setMatrixRaysVisible(true); // show every pair's rays until a pair is focused
      const act = next[`${activeTxId}|${activeRxId}`];
      if (act) { setPaths(act.paths); setMetrics(act.metrics); }
      setBackendOnline(true);
    } catch (e: any) {
      status = 'error'; errorText = e?.message || 'Matrix solve failed';
      setSolveError(errorText);
      checkBackend().then(setBackendOnline);
    } finally {
      setMatrixLoading(false);
      setMatrixProgress('');
      const pairSummaries = Object.values(next).map((cell) => ({ txId: cell.txId, rxId: cell.rxId, pathCount: cell.paths.length, metrics: cell.metrics }));
      await safeCreateExperiment({
        name: `All-pairs link matrix · ${txs.length} TX × ${rxs.length} RX`, kind: 'link_matrix', status,
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        seed: solverOptions.pathSeed,
        configuration: { txs, rxs, freqGhz, maxDepth, solverOptions, materials: materialList, scene: { anchor, buildingCount: buildings.length, geometryFingerprint: sceneGeometryFingerprint } },
        parameters: { txCount: txs.length, rxCount: rxs.length, totalPairs: total, solvedPairs: Object.keys(next).length, freqGhz, maxDepth, pathSamplesPerSource: solverOptions.pathSamplesPerSource, seed: solverOptions.pathSeed },
        results: { solvedPairs: pairSummaries }, error: errorText,
        replay: { endpoint: '/api/solve', body: { kind: 'link_matrix', txs, rxs, buildings, freqGhz, maxDepth, options: solverOptions, materials: materialList }, description: 'Repeat every transmitter–receiver pair in the link matrix' },
      });
    }
  };

  // All multipath from every solved Tx→Rx pair, combined for the 3D scene
  // (empty once the user focuses a single pair).
  const matrixPaths = React.useMemo(
    () => (matrixRaysVisible ? Object.values(matrix).flatMap((c: MatrixCell) => c.paths) : []),
    [matrix, matrixRaysVisible],
  );

  // Device-list selection keeps the all-pairs matrix intact. If that selected
  // pair has already been solved, reuse its cached result; otherwise clear only
  // the focused single-link readout (not the matrix itself).
  const handleSelectTx = (txId: string) => {
    setActiveTxId(txId);
    const cell = matrix[`${txId}|${activeRxId}`];
    setPaths(cell?.paths ?? []);
    setMetrics(cell?.metrics ?? EMPTY_METRICS);
    setMatrixRaysVisible(false);
  };
  const handleSelectRx = (rxId: string) => {
    setActiveRxId(rxId);
    const cell = matrix[`${activeTxId}|${rxId}`];
    setPaths(cell?.paths ?? []);
    setMetrics(cell?.metrics ?? EMPTY_METRICS);
    setMatrixRaysVisible(false);
  };

  // Selecting a matrix cell focuses that Tx→Rx pair and shows its multipath.
  // The matrix remains a reusable cache until a physical solve input changes.
  const handleSelectPair = (txId: string, rxId: string) => {
    setActiveTxId(txId);
    setActiveRxId(rxId);
    const cell = matrix[`${txId}|${rxId}`];
    if (cell) {
      setPaths(cell.paths);
      setMetrics(cell.metrics);
      setMatrixRaysVisible(false); // 3D shows just this pair's rays
    }
  };

  // ── Device list management (add / remove / select) ──────────────────────
  const addTx = () => {
    const enu = { x: tx.enu.x + 30, y: tx.enu.y - 20, z: 0 };
    const ll = enuToLatLon(enu, anchor);
    const nt: Transmitter = { ...tx, id: `tx_${Date.now()}`, name: `Tx ${txs.length + 1}`, enu, latitude: ll.lat, longitude: ll.lon };
    setTxs((p) => [...p, nt]);
    setActiveTxId(nt.id);
    setPlacementMode('tx'); // arm: next click in the 3D scene positions the new Tx
  };
  const removeTx = (id: string) => {
    if (txs.length <= 1) return;
    const remaining = txs.filter((t) => t.id !== id);
    setTxs(remaining);
    if (activeTxId === id) setActiveTxId(remaining[0].id);
  };
  const addRx = () => {
    const enu = { x: rx.enu.x - 30, y: rx.enu.y + 20, z: 0 };
    const ll = enuToLatLon(enu, anchor);
    const nr: Receiver = { ...rx, id: `rx_${Date.now()}`, name: `Rx ${rxs.length + 1}`, enu, latitude: ll.lat, longitude: ll.lon };
    setRxs((p) => [...p, nr]);
    setActiveRxId(nr.id);
    setPlacementMode('rx'); // arm: next click in the 3D scene positions the new Rx
  };
  const removeRx = (id: string) => {
    if (rxs.length <= 1) return;
    const remaining = rxs.filter((r) => r.id !== id);
    setRxs(remaining);
    if (activeRxId === id) setActiveRxId(remaining[0].id);
  };

  // Custom coordinate transmitter coordinate update callback (active device).
  const handleTxUpdate = (updatedTx: Transmitter) => {
    // Re-evaluate Lat/Lon back from ENU coordinate updates
    const latLon = enuToLatLon(updatedTx.enu, anchor);
    setTxs((prev) =>
      prev.map((t) => (t.id === updatedTx.id ? { ...updatedTx, latitude: latLon.lat, longitude: latLon.lon } : t)),
    );
  };

  const handleImportBaseStations = (imported: Transmitter[], replaceExisting: boolean) => {
    // Re-importing the same spreadsheet in append mode must not create duplicate
    // React keys or collide with existing transmitter identities.
    const usedIds = new Set(replaceExisting ? [] : txs.map((item) => item.id));
    const uniqueImported = imported.map((item) => {
      const baseId = item.id;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
      usedIds.add(id);
      return id === item.id ? item : { ...item, id };
    });
    const next = replaceExisting ? uniqueImported : [...txs, ...uniqueImported];
    setTxs(next);
    if (uniqueImported.length) setActiveTxId(uniqueImported[0].id);
    const importedBands = Array.from(new Set(uniqueImported.map((item) => item.frequencyBand).filter((band): band is string => Boolean(band))));
    setCoverageBandFilter(importedBands.length === 1 ? importedBands[0] : '__all__');
    setConfirmedCarrierBand(null);
    setRadioMap(null);
    setPaths([]);
    setSolveError('');
    setActiveNavTab('3d_scene');
  };

  const handleCoverageBandSelect = (band: string) => {
    setCoverageBandFilter(band);
    setConfirmedCarrierBand(null);
    setRadioMap(null);
  };

  const handleSetFreqGhz = (value: number) => {
    setFreqGhz(value);
    // If exact carrier metadata is absent, a manual RF-control edit after
    // selecting the band is an explicit user confirmation of the channel.
    setConfirmedCarrierBand(coverageBandFilter);
  };

  const handleRxUpdate = (updatedRx: Receiver) => {
    const latLon = enuToLatLon(updatedRx.enu, anchor);
    setRxs((prev) =>
      prev.map((r) => (r.id === updatedRx.id ? { ...updatedRx, latitude: latLon.lat, longitude: latLon.lon } : r)),
    );
  };

  // OVERPASS GIS DOWNLOAD PIPELINE. `buildings` is the authoritative OSM feature
  // dataset used by the backend/Sionna scene. ThreeStudio derives disposable,
  // batched preview BufferGeometry from it; renderer LOD/batching never edits or
  // substitutes the source footprints sent to the physical solver.
  const handleDownloadOSM = async (bounds: L.LatLngBounds) => {
    setGisLoading(true);
    setDownloadProgress('Sending OSM tile request through the SionnaRTStudio backend proxy...');
    try {
      const south = bounds.getSouth();
      const west = bounds.getWest();
      const north = bounds.getNorth();
      const east = bounds.getEast();

      // fetchOSMBuildings reports which mirror it is on; the local parse/compile
      // message comes after the network is done, so a stalled mirror can never
      // look like slow XML compilation again.
      const loadedBuildings = await fetchOSMBuildings(
        south, west, north, east, anchor, setDownloadProgress,
      );
      setDownloadProgress('Compiling XML building shapes...');

      if (loadedBuildings.length === 0) {
        setDownloadProgress('No buildings found in this bounding extent, keeping preloaded coordinates.');
        return;
      }

      setBuildings(loadedBuildings);
      setDownloadProgress(`Twin mapped successfully! Mapped ${loadedBuildings.length} active structures.`);
    } catch (e: any) {
      setDownloadProgress(`Fetch failed: ${e.message || 'Check connections'}`);
    } finally {
      // Do not leave Fetch/Reset disabled if a request fails or returns early.
      setGisLoading(false);
    }
  };

  // MOBILITY — real Sionna link solve at each Rx waypoint (incl. Doppler).
  const [mobilitySteps, setMobilitySteps] = useState<MobilityStep[]>([]);
  const [mobilityLoading, setMobilityLoading] = useState(false);
  const [mobilityProgress, setMobilityProgress] = useState('');
  const [mobilityExecution, setMobilityExecution] = useState<MobilityExecution | null>(null);
  // How multiple transmitters collapse into each waypoint's KPIs (best-server vs
  // total power); the rays drawn are the union of all Tx in either case.
  const [mobilityCombineMode, setMobilityCombineMode] = useState<MobilityCombineMode>(
    () => AUTOSAVED_PROJECT?.mobility.combineMode ?? 'best_server',
  );
  // A3 handover parameters (applied on the next Run Mobility) + the backend's
  // hysteresis/TTT association analysis for the last run.
  const [handoverConfig, setHandoverConfig] = useState<HandoverConfig>(
    () => AUTOSAVED_PROJECT?.mobility.handover ?? { hysteresisDb: 3, timeToTriggerMs: 160 },
  );
  const [mobilitySpeedKmh, setMobilitySpeedKmh] = useState(
    () => AUTOSAVED_PROJECT?.mobility.speedKmh ?? 30,
  );
  const [mobilityIntervalMs, setMobilityIntervalMs] = useState(
    () => AUTOSAVED_PROJECT?.mobility.intervalMs ?? 100,
  );
  const [mobilityHandover, setMobilityHandover] = useState<HandoverAnalysis | null>(null);
  const [autosaveStatus, setAutosaveStatus] = useState<'saving' | 'saved' | 'error'>('saving');
  const resettingRef = useRef(false);

  const projectState = React.useMemo<StudioProjectState>(() => ({
    scene: { anchor, buildings },
    devices: {
      transmitters: txs,
      receivers: rxs,
      activeTxId,
      activeRxId,
    },
    solver: {
      carrierFrequencyGhz: freqGhz,
      maxDepth,
      options: solverOptions,
      materialConfigs,
    },
    coverage: {
      metric: coverageMetric,
      bandwidthMhz: coverageBandwidthMhz,
      noiseFigureDb: coverageNoiseFigureDb,
      heightM: coverageHeight,
      gridStepM: coverageRes,
      samplesPerTx: coverageSamplesPerTx,
      seed: radioMapSeed,
    },
    mobility: {
      trajectoryPoints,
      combineMode: mobilityCombineMode,
      handover: handoverConfig,
      speedKmh: mobilitySpeedKmh,
      intervalMs: mobilityIntervalMs,
    },
    display: {
      activeNavTab,
      activeMode,
      showOutlines,
      showRaysOnHeatmap,
      radioMapColormap: rmColormap,
      radioMapAutoRange: rmAutoRange,
      radioMapVmin: rmVmin,
      radioMapVmax: rmVmax,
    },
  }), [
    anchor, buildings, txs, rxs, activeTxId, activeRxId, freqGhz, maxDepth,
    solverOptions, materialConfigs, coverageMetric, coverageBandwidthMhz,
    coverageNoiseFigureDb, coverageHeight, coverageRes, coverageSamplesPerTx,
    radioMapSeed, trajectoryPoints, mobilityCombineMode, handoverConfig,
    mobilitySpeedKmh, mobilityIntervalMs, activeNavTab, activeMode, showOutlines,
    showRaysOnHeatmap, rmColormap, rmAutoRange, rmVmin, rmVmax,
  ]);

  // Persist only editable inputs and display choices. Solver outputs are
  // intentionally omitted because they become stale whenever an input changes.
  useEffect(() => {
    setAutosaveStatus('saving');
    const timeout = window.setTimeout(() => {
      // A reset clears storage and reloads; a debounced write landing in that
      // window would restore the state the user just discarded.
      if (resettingRef.current) return;
      try {
        saveAutosavedProject(projectState);
        setAutosaveStatus('saved');
      } catch (error) {
        console.warn('Could not autosave the SionnaRTStudio project.', error);
        setAutosaveStatus('error');
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectState]);

  // Discard the autosave and reload. Every state hook seeds itself from the
  // module-level AUTOSAVED_PROJECT snapshot, so a reload is what actually
  // returns the studio to its defaults.
  const handleResetProject = () => {
    const confirmed = window.confirm(
      'Reset the studio to its defaults?\n\n'
      + 'This discards the autosaved project: scene geometry, every transmitter '
      + 'and receiver, solver and material settings, trajectory, and coverage '
      + 'controls. Exported files are not affected.\n\n'
      + 'Export the project first if you want to keep it.',
    );
    if (!confirmed) return;
    resettingRef.current = true;
    clearAutosavedProject();
    window.location.reload();
  };


  const handleImportProject = (text: string) => {
    const imported = parseProjectDocument(text).state;
    setAnchor(imported.scene.anchor);
    setBuildings(imported.scene.buildings);
    setTxs(imported.devices.transmitters);
    setRxs(imported.devices.receivers);
    setActiveTxId(imported.devices.activeTxId);
    setActiveRxId(imported.devices.activeRxId);
    setFreqGhz(imported.solver.carrierFrequencyGhz);
    setMaxDepth(imported.solver.maxDepth);
    setSolverOptions(imported.solver.options);
    setMaterialConfigs(imported.solver.materialConfigs);
    setCoverageMetric(imported.coverage.metric);
    setCoverageBandwidthMhz(imported.coverage.bandwidthMhz);
    setCoverageNoiseFigureDb(imported.coverage.noiseFigureDb);
    setCoverageHeight(imported.coverage.heightM);
    setCoverageRes(imported.coverage.gridStepM);
    setCoverageSamplesPerTx(imported.coverage.samplesPerTx);
    setRadioMapSeed(imported.coverage.seed);
    setTrajectoryPoints(imported.mobility.trajectoryPoints);
    setMobilityCombineMode(imported.mobility.combineMode);
    setHandoverConfig(imported.mobility.handover);
    setMobilitySpeedKmh(imported.mobility.speedKmh);
    setMobilityIntervalMs(imported.mobility.intervalMs);
    setActiveNavTab(imported.display.activeNavTab);
    setActiveMode(imported.display.activeMode);
    setShowOutlines(imported.display.showOutlines);
    setShowRaysOnHeatmap(imported.display.showRaysOnHeatmap);
    setRmColormap(imported.display.radioMapColormap);
    setRmAutoRange(imported.display.radioMapAutoRange);
    setRmVmin(imported.display.radioMapVmin);
    setRmVmax(imported.display.radioMapVmax);

    setPlacementMode('none');
    setPaths([]);
    setMetrics(EMPTY_METRICS);
    setMatrix({});
    setMatrixRaysVisible(false);
    setRadioMap(null);
    setMobilitySteps([]);
    setActiveMobilityStep(null);
    setMobilityExecution(null);
    setMobilityHandover(null);
    setSolveError('');
  };

  // Each sample is a full GPU ray trace, so cap the trajectory resolution.
  const MAX_MOBILITY_STEPS = 100;

  const sampleMobilityPath = (intervalMs: number, speedKmh: number) => {
    if (trajectoryPoints.length < 2) return trajectoryPoints;
    const speedMs = Math.max(speedKmh / 3.6, 0.1);
    const stepMeters = Math.max(speedMs * (intervalMs / 1000), 0.05);

    // Cumulative arc length along the drawn polyline.
    const cum = [0];
    for (let i = 1; i < trajectoryPoints.length; i++) {
      const a = trajectoryPoints[i - 1].enu;
      const b = trajectoryPoints[i].enu;
      cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const total = cum[cum.length - 1];
    if (total < 1e-6) return [trajectoryPoints[0]];

    const numSegments = Math.min(
      Math.max(Math.ceil(total / stepMeters), 1),
      MAX_MOBILITY_STEPS - 1,
    );
    const sampled: typeof trajectoryPoints = [];
    let seg = 1;
    for (let s = 0; s <= numSegments; s++) {
      const d = (s / numSegments) * total;
      while (seg < cum.length - 1 && cum[seg] < d) seg++;
      const t = (d - cum[seg - 1]) / Math.max(cum[seg] - cum[seg - 1], 1e-9);
      const a = trajectoryPoints[seg - 1];
      const b = trajectoryPoints[seg];
      sampled.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        enu: {
          x: a.enu.x + (b.enu.x - a.enu.x) * t,
          y: a.enu.y + (b.enu.y - a.enu.y) * t,
          z: a.enu.z + (b.enu.z - a.enu.z) * t,
        },
      });
    }
    return sampled;
  };

  const handleRunMobility = async (speedKmh: number, intervalMs: number) => {
    if (trajectoryPoints.length < 2) {
      setSolveError('Draw at least two mobility waypoints in the 3D scene.');
      return;
    }
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    let status: 'done' | 'error' = 'done';
    let resultSummary: Record<string, unknown> = {};
    let errorText: string | null = null;
    let replayBody: Record<string, unknown> = {};
    let waypointCount = 0;
    setMobilityLoading(true);
    setSolveError('');
    try {
      setActiveMobilityStep(null);
      setMobilitySteps([]);
      setMobilityExecution(null);
      setMobilityHandover(null);
      const sampledPath = sampleMobilityPath(intervalMs, speedKmh);
      setTrajectoryPoints(sampledPath);
      const waypoints = sampledPath.map((p) => ({ x: p.enu.x, y: p.enu.y, z: p.enu.z }));
      waypointCount = waypoints.length;
      replayBody = { txs, rx, buildings, waypoints, freqGhz, speedKmh, maxDepth, options: solverOptions, materials: materialList, combineMode: mobilityCombineMode, executionMode: 'auto', handover: handoverConfig };

      // One API request preserves the backend's one-PathSolver-dispatch fast
      // path over all Tx × waypoints and makes the browser workflow identical
      // to the benchmarked workflow. The response exposes any serial fallback.
      setMobilityProgress(`Batching ${txs.length} Tx × ${waypoints.length} positions on the GPU…`);
      const res = await solveMobility(
        txs, rx, buildings, waypoints,
        freqGhz, speedKmh, maxDepth, solverOptions, materialList, mobilityCombineMode,
        'auto', handoverConfig,
      );
      const all = res.steps.map((step, index) => ({ ...step, index }));
      setMobilityExecution(res.execution);
      setMobilityHandover(res.handover ?? null);
      setMobilitySteps(all);
      if (all[0]) handleMobilityStepSelect(all[0]);
      resultSummary = summarizeUnknownExperimentResult('mobility', res);
      setBackendOnline(true);
    } catch (err: any) {
      console.error(err);
      status = 'error'; errorText = err?.message || 'Mobility solve failed';
      setSolveError(errorText);
      checkBackend().then(setBackendOnline);
    } finally {
      setMobilityLoading(false);
      setMobilityProgress('');
      await safeCreateExperiment({
        name: `Mobility · ${txs.length} TX · ${waypointCount || trajectoryPoints.length} waypoints`, kind: 'mobility', status,
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        seed: solverOptions.pathSeed,
        configuration: { txs, rx, freqGhz, maxDepth, solverOptions, materials: materialList, mobilityCombineMode, handoverConfig, scene: { anchor, buildingCount: buildings.length, geometryFingerprint: sceneGeometryFingerprint } },
        parameters: { speedKmh, intervalMs, waypointCount, txCount: txs.length, combineMode: mobilityCombineMode, handover: handoverConfig, seed: solverOptions.pathSeed },
        results: resultSummary, error: errorText,
        replay: status === 'done' ? { endpoint: '/api/mobility', body: replayBody, description: 'Repeat mobility path simulation' } : { endpoint: '/api/mobility', body: replayBody, description: 'Retry failed mobility path simulation' },
      });
    }
  };


  const handleMobilityStepSelect = (step: MobilityStep) => {
    setActiveMobilityStep(step);
    setPaths(step.paths);
    setMetrics(metricsFromMobilityStep(step));
  };

  // COVERAGE HEATMAP — real Sionna RadioMapSolver, best-server across all Tx.
  const handleRunHeatmap = async (resolution: number, height: number, samplesPerTx: number, seed: number) => {
    if (coverageBandOptions.length > 1 && coverageBandFilter === '__all__') {
      setSolveError('Multiple frequency-band groups were imported. Select one Frequency Band group before computing a radio map; different bands must not be treated as co-channel interferers.');
      return;
    }
    const selectedTransmitters = coverageBandFilter !== '__all__' ? coverageTxs : txs;
    const mixedClassifiedAndUnclassified = selectedTransmitters.some((item) => !item.frequencyBand)
      && selectedTransmitters.some((item) => Boolean(item.frequencyBand));
    if (mixedClassifiedAndUnclassified) {
      setSolveError('The selected group contains transmitters both with and without Frequency Band metadata. Remove unclassified transmitters or re-import the table using Replace current transmitters.');
      return;
    }
    if (!selectedTransmitters.length) {
      setSolveError('The selected Frequency Band group contains no transmitters.');
      return;
    }
    const knownCarriers: number[] = Array.from(new Set<number>(selectedTransmitters
      .map((item) => item.carrierFrequencyGhz)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))));
    if (knownCarriers.length > 1) {
      setSolveError(`The selected group contains multiple exact carrier frequencies (${knownCarriers.join(', ')} GHz). Separate them before running RadioMapSolver.`);
      return;
    }
    if (knownCarriers.length === 1 && Math.abs(knownCarriers[0] - freqGhz) > 0.001) {
      setSolveError(`The RF controls are set to ${freqGhz} GHz, but the imported table lists ${knownCarriers[0]} GHz for the selected group. Align the carrier frequency before running the calculation.`);
      return;
    }
    const hasImportedBandWithoutExactCarrier = selectedTransmitters.some(
      (item) => Boolean(item.frequencyBand) && !Number.isFinite(item.carrierFrequencyGhz),
    );
    const selectedBandKey = coverageBandFilter !== '__all__' ? coverageBandFilter : '__all__';
    if (hasImportedBandWithoutExactCarrier && confirmedCarrierBand !== selectedBandKey) {
      setSolveError('The table contains a Frequency Band label but no exact carrier frequency. Select a band group, enter the deployed downlink carrier in RF Controls, and only then run the radio map. Labels such as n78, GSM 900, or 791/2110 MHz are not sufficient to determine the channel.');
      return;
    }
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    const coverageRequest = { metric: coverageMetric, coverageThresholdDb, rssCoverageThresholdDb: -100, sinrCoverageThresholdDb: 0, bandwidthHz: coverageBandwidthMhz * 1e6, noiseFigureDb: coverageNoiseFigureDb, samplesPerTx, seed };
    const replayBody = { txs: selectedTransmitters, buildings, freqGhz, gridSize: resolution, gridHeight: height, maxDepth, options: solverOptions, materials: materialList, ...coverageRequest };
    let status: 'done' | 'error' = 'done';
    let resultSummary: Record<string, unknown> = {};
    let errorText: string | null = null;
    setLoadingHeatmap(true);
    setSolveError('');
    try {
      const grid = await solveRadioMap(
        selectedTransmitters, buildings, freqGhz, resolution, height, maxDepth, solverOptions, materialList,
        coverageRequest,
      );
      setRadioMap({
        ...grid,
        geoReference: {
          crs: 'EPSG:4326',
          anchor: { ...anchor },
          method: 'WGS84_LOCAL_TANGENT_ENU',
          note: 'Local WGS84 tangent-plane ENU conversion; accuracy depends on the scene anchor and is intended for local-area scenes.',
        },
      });
      resultSummary = summarizeUnknownExperimentResult('radio_map', grid);
      setBackendOnline(true);
    } catch (err: any) {
      console.error(err);
      status = 'error'; errorText = err?.message || 'Radio map failed';
      setSolveError(errorText);
      checkBackend().then(setBackendOnline); // a solve error != backend offline
    } finally {
      setLoadingHeatmap(false);
      await safeCreateExperiment({
        name: `Radio map · ${coverageMetric} · ${selectedTransmitters.length} TX`, kind: 'radio_map', status,
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        seed, configuration: { txs: selectedTransmitters, freqGhz, maxDepth, solverOptions, materials: materialList, coverageRequest, scene: { anchor, buildingCount: buildings.length, geometryFingerprint: sceneGeometryFingerprint } },
        parameters: { metric: coverageMetric, gridSize: resolution, gridHeight: height, samplesPerTx, seed, noiseFigureDb: coverageNoiseFigureDb, bandwidthHz: coverageBandwidthMhz * 1e6, maxDepth, frequencyGhz: freqGhz, transmitterCount: selectedTransmitters.length },
        results: resultSummary, error: errorText,
        replay: { endpoint: '/api/radiomap', body: replayBody, description: 'Repeat RadioMapSolver run' },
      });
    }
  };

  const sceneEnuBounds = React.useMemo(() => {
    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    for (const item of buildings) {
      for (const point of item.enuPoints ?? []) {
        xMin = Math.min(xMin, point.x);
        xMax = Math.max(xMax, point.x);
        yMin = Math.min(yMin, point.y);
        yMax = Math.max(yMax, point.y);
      }
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
    return { xMin, xMax, yMin, yMax };
  }, [buildings]);

  const currentExperimentConfiguration = React.useMemo(() => ({
    tx, rx, freqGhz, maxDepth, solverOptions, materials: materialList,
    scene: { anchor, buildingCount: buildings.length, geometryFingerprint: sceneGeometryFingerprint },
  }), [tx, rx, freqGhz, maxDepth, solverOptions, materialList, anchor, buildings.length, sceneGeometryFingerprint]);

  const handleApplyExperimentConfiguration = (configuration: Record<string, unknown>) => {
    const cfg = configuration as Record<string, any>;
    if (Number.isFinite(cfg.freqGhz)) handleSetFreqGhz(Number(cfg.freqGhz));
    if (Number.isFinite(cfg.maxDepth)) setMaxDepth(Math.max(0, Math.min(10, Math.round(Number(cfg.maxDepth)))));
    if (cfg.solverOptions && typeof cfg.solverOptions === 'object') setSolverOptions(cfg.solverOptions as SolverOptions);
    if (Array.isArray(cfg.materials)) {
      const next = Object.fromEntries((cfg.materials as MaterialConfig[]).filter((item) => item && typeof item.id === 'string').map((item) => [item.id, item]));
      setMaterialConfigs((current) => ({ ...current, ...next }));
    }
    if (cfg.tx && typeof cfg.tx.id === 'string') {
      const savedTx = cfg.tx as Transmitter;
      setTxs((current) => current.some((item) => item.id === savedTx.id)
        ? current.map((item) => item.id === savedTx.id ? savedTx : item)
        : [...current, savedTx]);
      setActiveTxId(savedTx.id);
    }
    if (cfg.rx && typeof cfg.rx.id === 'string') {
      const savedRx = cfg.rx as Receiver;
      setRxs((current) => current.some((item) => item.id === savedRx.id)
        ? current.map((item) => item.id === savedRx.id ? savedRx : item)
        : [...current, savedRx]);
      setActiveRxId(savedRx.id);
    }
  };

  const handleRetryExperiment = async (experiment: ExperimentRun) => {
    if (!experiment.replay?.endpoint) throw new Error('This experiment has no saved replay payload.');
    const replay = experiment.replay;
    if (!replay.endpoint.startsWith('/api/')) throw new Error('Replay endpoint must use the local /api/ prefix.');
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    const retryRecord = await safeCreateExperiment({
      name: `${experiment.name} · retry`, kind: experiment.kind, status: 'running', startedAtUtc,
      seed: experiment.seed, configuration: experiment.configuration,
      parameters: { ...experiment.parameters, retryOf: experiment.id },
      results: { retryOf: experiment.id, status: 'starting' }, replay,
    });
    let retryWasCancelled = false;
    try {
      let raw: any;
      if (experiment.kind === 'link_matrix' && Array.isArray((replay.body as any).txs) && Array.isArray((replay.body as any).rxs)) {
        const matrix = replay.body as any;
        const solvedPairs: any[] = [];
        for (const t of matrix.txs) {
          for (const r of matrix.rxs) {
            const pairResponse = await fetch('/api/solve', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tx: t, rx: r, buildings: matrix.buildings, freqGhz: matrix.freqGhz, maxDepth: matrix.maxDepth, options: matrix.options, materials: matrix.materials }),
            });
            if (!pairResponse.ok) {
              let detail = `Link matrix pair failed (${pairResponse.status})`;
              try { const body = await pairResponse.json(); detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body); } catch { /* keep fallback */ }
              throw new Error(`${t.name} → ${r.name}: ${detail}`);
            }
            const pair = await pairResponse.json();
            solvedPairs.push({ txId: t.id, rxId: r.id, pathCount: pair.paths?.length ?? 0, metrics: pair.metrics });
          }
        }
        raw = { solvedPairs };
      } else {
        const response = await fetch(replay.endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(replay.body),
        });
        if (!response.ok) {
          let detail = `Request failed (${response.status})`;
          try { const body = await response.json(); detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body); } catch { /* keep status fallback */ }
          throw new Error(detail);
        }
        raw = await response.json();
      }
      if (experiment.kind === 'measurement_raytrace' && raw?.jobId) {
        const retryJobId = raw.jobId as string;
        await safeUpdateExperiment(retryRecord?.id, { results: { jobId: retryJobId, status: 'running', progress: raw.progress ?? 0 } });
        let status = raw.status;
        for (let attempt = 0; attempt < 600 && ['running', 'cancelling'].includes(status); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          raw = await getMeasurementRayTraceJob(retryJobId);
          status = raw.status;
        }
        if (status === 'error') throw new Error(raw.message || 'Measurement ray-trace retry failed');
        if (status === 'cancelled') { retryWasCancelled = true; throw new Error(raw.message || 'Measurement ray-trace retry was cancelled'); }
        if (status !== 'done' || !raw.result) throw new Error('Measurement ray-trace retry exceeded the 15-minute polling window.');
        raw = raw.result;
      } else if (experiment.kind === 'phy_sweep' && raw?.jobId) {
        const retryJobId = raw.jobId as string;
        await safeUpdateExperiment(retryRecord?.id, { results: { jobId: retryJobId, status: 'running', progress: raw.progress ?? 0 } });
        let status = raw.status;
        for (let attempt = 0; attempt < 450 && ['running', 'cancelling'].includes(status); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          raw = await getPhyBerStatus(retryJobId);
          status = raw.status;
        }
        if (status === 'error') throw new Error(raw.message || 'PHY retry failed');
        if (status === 'cancelled') { retryWasCancelled = true; throw new Error(raw.message || 'PHY retry was cancelled'); }
        if (status !== 'done' || !raw.result) throw new Error('PHY retry exceeded the 15-minute polling window. Check Analysis for job status.');
        raw = raw.result;
      }
      const resultSummary = experiment.kind === 'measurement_raytrace'
        ? summarizeMeasurementRayTrace(raw)
        : summarizeUnknownExperimentResult(experiment.kind, raw);
      await safeUpdateExperiment(retryRecord?.id, {
        status: 'done', completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        results: resultSummary, error: null,
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      await safeUpdateExperiment(retryRecord?.id, {
        status: retryWasCancelled ? 'cancelled' : 'error', completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        error: errorText,
      });
      throw error;
    }
  };

  return (
    <div id="sionna-rt-studio-app-frame" className="min-h-screen lg:h-screen lg:overflow-hidden text-[var(--text-hi)] flex flex-col font-sans">
      <TopNav
        activeTab={activeNavTab}
        onSelect={setActiveNavTab}
        backendOnline={backendOnline}
      />

      {/* Main container Grid body */}
      <main className="flex-1 lg:min-h-0 p-6 grid grid-cols-1 lg:grid-cols-[430px_minmax(0,1fr)] gap-6 w-full">
        {/* Left column GIS mapping & parameter adjustments (4/12, 3/12 on wide screens) */}
        <div className="flex flex-col gap-6 animate-rise lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <MapSelector
            anchor={anchor}
            setAnchor={setAnchor}
            tx={tx}
            rx={rx}
            txs={txs}
            rxs={rxs}
            onTxUpdate={handleTxUpdate}
            onRxUpdate={handleRxUpdate}
            onDownloadOSM={handleDownloadOSM}
            onResetProject={handleResetProject}
            isLoading={gisLoading}
            downloadProgress={downloadProgress}
            trajectoryPoints={trajectoryPoints}
          />

          <BaseStationImportPanel
            anchor={anchor}
            currentTxCount={txs.length}
            onImport={handleImportBaseStations}
            defaultArraySize={[1, 1]}
          />

          <SolverControls
            tx={tx}
            rx={rx}
            onTxUpdate={handleTxUpdate}
            onRxUpdate={handleRxUpdate}
            activeMode={activeMode}
            setActiveMode={setActiveMode}
            freqGhz={freqGhz}
            setFreqGhz={handleSetFreqGhz}
            maxDepth={maxDepth}
            setMaxDepth={setMaxDepth}
            solverOptions={solverOptions}
            setSolverOptions={setSolverOptions}
          />

          {/* Keep mode panels mounted while hidden. Their local results, selected
              cells and in-flight operation state must survive switching between
              Link / Radio Coverage / Trajectory. Only the visible panel occupies
              layout space. */}
          <div className={activeMode === 'link' ? 'contents' : 'hidden'}>
            <LinkPanel
              txs={txs}
              rxs={rxs}
              activeTxId={activeTxId}
              activeRxId={activeRxId}
              onSelectTx={handleSelectTx}
              onSelectRx={handleSelectRx}
              onAddTx={addTx}
              onAddRx={addRx}
              onRemoveTx={removeTx}
              onRemoveRx={removeRx}
              matrix={matrix}
              matrixLoading={matrixLoading}
              matrixProgress={matrixProgress}
              onSolveMatrix={handleSolveMatrix}
              onSelectPair={handleSelectPair}
              paths={paths}
              metrics={metrics}
              onSolve={handleSolve}
              solving={solving}
              solveError={solveError}
              backendOnline={backendOnline}
            />
          </div>

          <div className={activeMode === 'heatmap' ? 'contents' : 'hidden'}>
            <CoveragePanel
              txCount={coverageBandFilter !== '__all__' ? coverageTxs.length : txs.length}
              rx={rx}
              bandOptions={coverageBandOptions}
              selectedBand={coverageBandFilter}
              onSelectBand={handleCoverageBandSelect}
              backendOnline={backendOnline}
              onRunHeatmap={handleRunHeatmap}
              heatmapLoading={loadingHeatmap}
              radioMap={radioMap}
              anchor={anchor}
              txs={coverageTxs}
              onFocusCell={setFocusedRadioMapCellIndex}
              focusedRadioMapCellIndex={focusedRadioMapCellIndex}
              coverageMetric={coverageMetric}
              setCoverageMetric={handleCoverageMetricChange}
              coverageThresholdDb={coverageThresholdDb}
              setCoverageThresholdDb={setCoverageThresholdDb}
              coverageBandwidthMhz={coverageBandwidthMhz}
              setCoverageBandwidthMhz={setCoverageBandwidthMhz}
              coverageNoiseFigureDb={coverageNoiseFigureDb}
              setCoverageNoiseFigureDb={setCoverageNoiseFigureDb}
              coverageHeight={coverageHeight}
              setCoverageHeight={setCoverageHeight}
              coverageRes={coverageRes}
              setCoverageRes={setCoverageRes}
              samplesPerTx={coverageSamplesPerTx}
              setSamplesPerTx={setCoverageSamplesPerTx}
              radioMapSeed={radioMapSeed}
              setRadioMapSeed={setRadioMapSeed}
              showRaysOnHeatmap={showRaysOnHeatmap}
              setShowRaysOnHeatmap={setShowRaysOnHeatmap}
              rmColormap={rmColormap}
              setRmColormap={setRmColormap}
              rmAutoRange={rmAutoRange}
              setRmAutoRange={setRmAutoRange}
              rmVmin={rmVmin}
              setRmVmin={setRmVmin}
              rmVmax={rmVmax}
              setRmVmax={setRmVmax}
              solveError={solveError}
            />
          </div>

          <div className={activeMode === 'playback' ? 'contents' : 'hidden'}>
            <TrajectoryPanel
              txs={txs}
              activeTxId={activeTxId}
              onSelectTx={setActiveTxId}
              onAddTx={addTx}
              onRemoveTx={removeTx}
              tx={tx}
              rx={rx}
              anchor={anchor}
              trajectoryPoints={trajectoryPoints}
              setTrajectoryPoints={setTrajectoryPoints}
              mobilitySteps={mobilitySteps}
              mobilityLoading={mobilityLoading}
              mobilityProgress={mobilityProgress}
              mobilityExecution={mobilityExecution}
              onRunMobility={handleRunMobility}
              onMobilityStepSelect={handleMobilityStepSelect}
              mobilitySpeedKmh={mobilitySpeedKmh}
              setMobilitySpeedKmh={setMobilitySpeedKmh}
              mobilityIntervalMs={mobilityIntervalMs}
              setMobilityIntervalMs={setMobilityIntervalMs}
              mobilityCombineMode={mobilityCombineMode}
              setMobilityCombineMode={setMobilityCombineMode}
              handoverConfig={handoverConfig}
              setHandoverConfig={setHandoverConfig}
              mobilityHandover={mobilityHandover}
              solveError={solveError}
              backendOnline={backendOnline}
              active={activeMode === 'playback'}
            />
          </div>
        </div>

        {/* Center/Right columns visualization viewport (8/12, 9/12 on wide screens) — content swaps with the top nav */}
        <div className="flex flex-col gap-6 animate-rise lg:min-h-0 lg:overflow-y-auto lg:pr-1" style={{ animationDelay: '0.08s' }}>
          {/* Main 3D WebGL Canvas */}
          {activeNavTab === '3d_scene' && (
            <ThreeStudio
              buildings={buildings}
              anchor={anchor}
              tx={tx}
              rx={rx}
              txs={txs}
              rxs={rxs}
              activeTxId={activeTxId}
              activeRxId={activeRxId}
              paths={paths}
              matrixPaths={matrixPaths}
              showRaysOnHeatmap={showRaysOnHeatmap}
              radioMap={radioMap}
              focusedRadioMapCellIndex={focusedRadioMapCellIndex}
              rmColormap={rmColormap}
              rmAutoRange={rmAutoRange}
              rmVmin={rmVmin}
              rmVmax={rmVmax}
              onTxUpdate={handleTxUpdate}
              onRxUpdate={handleRxUpdate}
              activeMode={activeMode}
              placementMode={placementMode}
              setPlacementMode={setPlacementMode}
              showOutlines={showOutlines}
              setShowOutlines={setShowOutlines}
              mobilityRxPosition={activeMobilityStep?.rxPosition ?? null}
              trajectoryPoints={trajectoryPoints}
              setTrajectoryPoints={setTrajectoryPoints}
              measurementOverlayPoints={measurementOverlayPoints}
              measurementOverlayLabel={measurementOverlayLabel}
              measurementOverlayVisible={measurementOverlayVisible}
              setMeasurementOverlayVisible={setMeasurementOverlayVisible}
            />
          )}

          {/* Keep workspaces alive across top-navigation changes. In particular,
              Field Validation must retain its selected identity audit when its
              "show in 3D" action navigates to the 3D scene, and Analysis must
              keep polling a running PHY job while the user visits another tab. */}
          <div className={activeNavTab === 'geography' ? 'contents' : 'hidden'}>
            <GeographyPanel
              buildings={buildings}
              anchor={anchor}
              materialIds={materialIds}
              materialConfigs={materialList}
              onMaterialChange={updateMaterial}
            />
          </div>

          <div className={activeNavTab === 'analysis' ? 'contents' : 'hidden'}>
            <AnalysisPanel
              tx={tx}
              rx={rx}
              paths={paths}
              metrics={metrics}
              freqGhz={freqGhz}
              radioMap={radioMap}
              buildings={buildings}
              maxDepth={maxDepth}
              solverOptions={solverOptions}
              materials={materialList}
              backendOnline={backendOnline}
            />
          </div>

          <div className={activeNavTab === 'field_validation' ? 'contents' : 'hidden'}>
            <FieldValidationPanel backendOnline={backendOnline} anchor={anchor} sceneBounds={sceneEnuBounds} transmitters={txs} rxArraySize={rx.antennaArraySize} buildings={buildings} freqGhz={freqGhz} maxDepth={maxDepth} solverOptions={solverOptions} materials={materialList} onShowMeasurementsIn3D={showMeasurementOverlayIn3D} onClearMeasurementOverlay={clearMeasurementOverlay} />
          </div>

          <div className={activeNavTab === 'experiments' ? 'contents' : 'hidden'}>
            <ExperimentPanel
              backendOnline={backendOnline}
              currentConfiguration={currentExperimentConfiguration}
              onApplyConfiguration={handleApplyExperimentConfiguration}
              onRetryExperiment={handleRetryExperiment}
            />
          </div>

          <div className={activeNavTab === 'export' ? 'contents' : 'hidden'}>
            <ExportPanel
              buildings={buildings}
              anchor={anchor}
              paths={paths}
              txs={txs}
              rxs={rxs}
              tx={tx}
              rx={rx}
              freqGhz={freqGhz}
              maxDepth={maxDepth}
              solverOptions={solverOptions}
              radioMap={radioMap}
              materials={materialList}
              projectState={projectState}
              autosaveStatus={autosaveStatus}
              onImportProject={handleImportProject}
              onResetProject={handleResetProject}
            />
          </div>

          {/* User tips documentation helper */}
          <div className="panel p-4 text-[14px] flex gap-3.5 text-slate-300">
            <div className="grid place-items-center w-9 h-9 shrink-0 bg-[var(--ink-750)] border border-[var(--line)] text-[var(--accent)] rounded-lg h-fit">
              <BookOpen className="w-4 h-4" />
            </div>
            <div className="flex flex-col gap-1.5">
              <h4 className="eyebrow">Propagation Studio · Quick Start</h4>
              <p className="leading-relaxed text-[var(--text-mid)]">
                Explore multipath reflections by choosing a geographic anchor on the map, then clicking{' '}
                <strong className="text-[var(--accent)] font-semibold">Fetch OSM Physical Twin</strong> to download buildings from the global Overpass API. Move antennas
                by dragging Leaflet markers, clicking <strong className="text-[var(--accent)] font-semibold">Place TX</strong> inside the 3D space, or editing the sliders.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
