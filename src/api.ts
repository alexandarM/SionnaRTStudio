// Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
// Upstream: https://github.com/puloktarafder/SionnaRTStudio

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client for the real Sionna RT backend (FastAPI). These replace the in-browser
 * approximate solvers in utils.ts. Vite proxies /api -> http://localhost:8000.
 */
import {
  BuildingFootprint,
  ChannelMetrics,
  CoverageMetric,
  DEFAULT_SOLVER_OPTIONS,
  MaterialConfig,
  MobilityCombineMode,
  PropagationPath,
  RadioMapGrid,
  SectorAnalysisResponse,
  DominantInterferenceMatrix,
  Receiver,
  SolverOptions,
  Transmitter,
} from './types';
import { withRequestTimeout } from './utils';

// Request budgets. A solve or export is genuinely slow (ray tracing, radio
// maps, mobility batches), so its ceiling is generous. PHY jobs execute in the
// background; their status endpoint should be fast, but Colab CPU contention
// and tunnel latency warrant a longer read timeout plus retrying in the UI.
const SOLVE_TIMEOUT_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
const POLL_TIMEOUT_MS = 60_000;

export interface SolveResponse {
  paths: PropagationPath[];
  metrics: ChannelMetrics;
}

// One transmitter's link to the Rx at a single waypoint (multi-Tx mobility).
export interface TxLinkMetrics {
  txId: string;
  txName: string;
  receivedPowerDbm: number;
  rmsDelaySpreadNs: number;
  numPaths: number;
  maxDopplerHz: number;
  losStatus: 'LOS' | 'NLOS';
}

export interface MobilityStep {
  index: number;
  rxPosition: { x: number; y: number; z: number };
  // Scalar KPIs describe the serving (best-server) transmitter at this waypoint.
  receivedPowerDbm: number;
  rmsDelaySpreadNs: number;
  rmsDelaySpreadValid?: boolean;
  numPaths: number;
  maxDopplerHz: number;
  losStatus: 'LOS' | 'NLOS';
  // Rays from every transmitter to this waypoint (each tagged with its txId).
  paths: PropagationPath[];
  // Best-server transmitter + the per-Tx breakdown behind the scalar KPIs.
  servingTxId?: string | null;
  servingTxName?: string | null;
  perTx?: TxLinkMetrics[];
}

export interface MobilityExecution {
  strategy: 'single_batched_dispatch' | 'serial_pair_fallback' | 'serial_reference';
  batchedResultUsed: boolean;
  transmitterCount: number;
  waypointCount: number;
  pairCount: number;
  successfulPathSolverDispatches: number;
  samplesPerSource: number;
  seed: number;
  solveTimeMs: number;
}

// A3-event handover parameters (3GPP): a neighbor must exceed the serving cell
// by hysteresisDb continuously for timeToTriggerMs before a handover fires.
export interface HandoverConfig {
  hysteresisDb: number;
  timeToTriggerMs: number;
  pingPongWindowS?: number;
}

export interface HandoverEvent {
  stepIndex: number;
  timeS: number;
  fromTxId: string;
  fromTxName: string;
  toTxId: string;
  toTxName: string;
  pingPong: boolean;
}

// A3 association over the mobility per-Tx RSS series. instantaneousChangeCount
// is the hysteresis-free baseline (how often the raw best server flips).
export interface HandoverAnalysis {
  hysteresisDb: number;
  timeToTriggerMs: number;
  pingPongWindowS: number;
  servingTxIds: (string | null)[];
  events: HandoverEvent[];
  handoverCount: number;
  pingPongCount: number;
  instantaneousChangeCount: number;
}

export interface MobilityResponse {
  steps: MobilityStep[];
  execution: MobilityExecution;
  handover?: HandoverAnalysis | null; // present when ≥ 2 Tx were solved
}

// Turn a failed Response into a readable message. FastAPI's `detail` is a string
// for our HTTPExceptions but an ARRAY of {loc,msg,type} objects for 422 request
// validation errors — JSON.stringify'ing that array is what produced the old
// "[object Object]" toast. Flatten it to "field: message" lines instead.
async function errorDetail(res: Response): Promise<string> {
  try {
    const j = await res.json();
    const d = j?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      return d
        .map((e: any) => {
          const where = Array.isArray(e?.loc) ? e.loc.filter((x: any) => x !== 'body').join('.') : '';
          return where ? `${where}: ${e?.msg ?? ''}` : e?.msg ?? JSON.stringify(e);
        })
        .join('; ');
    }
    if (d) return typeof d === 'object' ? JSON.stringify(d) : String(d);
  } catch {}
  return res.statusText || `Request failed (${res.status})`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(await errorDetail(res));
    }
    return (await res.json()) as T;
  });
}

// POST JSON, return the response as a downloadable blob with the filename the
// backend set via Content-Disposition (falling back to `fallbackName`).
async function postForBlob(
  url: string,
  body: unknown,
  fallbackName: string,
): Promise<{ blob: Blob; filename: string }> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(await errorDetail(res));
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    return { blob, filename: m ? m[1] : fallbackName };
  });
}

export async function checkBackend(): Promise<boolean> {
  try {
    return await withRequestTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const res = await fetch('/api/health', { signal });
      return res.ok;
    });
  } catch {
    return false;
  }
}

export function solveLink(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions = DEFAULT_SOLVER_OPTIONS,
  materials: MaterialConfig[] = [],
): Promise<SolveResponse> {
  return postJson<SolveResponse>('/api/solve', { tx, rx, buildings, freqGhz, maxDepth, options, materials });
}

// Extra coverage controls for the radio map (interference-aware SINR).
export interface CoverageOptions {
  metric?: CoverageMetric;
  bandwidthHz?: number;
  noiseFigureDb?: number;
  coverageThresholdDb?: number | null;
  rssCoverageThresholdDb?: number;
  sinrCoverageThresholdDb?: number;
  samplesPerTx?: number;
  seed?: number;
}

export function solveRadioMap(
  txs: Transmitter[],
  buildings: BuildingFootprint[],
  freqGhz: number,
  gridSize: number,
  gridHeight: number,
  maxDepth: number,
  options: SolverOptions = DEFAULT_SOLVER_OPTIONS,
  materials: MaterialConfig[] = [],
  coverage: CoverageOptions = {},
): Promise<RadioMapGrid> {
  // Best-server coverage across all transmitters (Sionna RadioMapSolver).
  return postJson<RadioMapGrid>('/api/radiomap', {
    txs,
    buildings,
    freqGhz,
    gridSize,
    gridHeight,
    maxDepth,
    options,
    materials,
    ...coverage,
  });
}

// Detailed map analytics are computed from the bounded backend cache; these
// requests do not invoke RadioMapSolver or repeat ray tracing.
async function getJson<T>(url: string): Promise<T> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as T;
  });
}

export function getRadioMapSectorAnalysis(mapId: string, txIndex: number): Promise<SectorAnalysisResponse> {
  return getJson<SectorAnalysisResponse>(`/api/radiomap/${encodeURIComponent(mapId)}/sector/${txIndex}/analysis`);
}

export function getRadioMapInterferenceMatrix(mapId: string, topK = 3): Promise<DominantInterferenceMatrix> {
  return getJson<DominantInterferenceMatrix>(`/api/radiomap/${encodeURIComponent(mapId)}/interference-matrix?top_k=${topK}`);
}

export async function downloadRadioMapSectorSamplesCsv(
  mapId: string,
  txIndex: number,
  criterion: 'weak_sinr' | 'weak_rss' | 'strong_interference',
  limit = 200,
): Promise<{ blob: Blob; filename: string }> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(
      `/api/radiomap/${encodeURIComponent(mapId)}/sector/${txIndex}/samples.csv?criterion=${criterion}&limit=${limit}`,
      { signal },
    );
    if (!res.ok) throw new Error(await errorDetail(res));
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    return { blob, filename: m ? m[1] : `radiomap_tx${txIndex}_${criterion}_samples.csv` };
  });
}

// Export one full transmitter layer on demand. The main RadioMap response keeps
// only summary KPIs for each transmitter; large per-cell arrays stay in the
// backend's bounded cache and are streamed to CSV only when requested.
export async function downloadRadioMapTxCsv(
  mapId: string,
  txIndex: number,
): Promise<{ blob: Blob; filename: string }> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`/api/radiomap/${encodeURIComponent(mapId)}/tx/${txIndex}/export.csv`, { signal });
    if (!res.ok) throw new Error(await errorDetail(res));
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    return { blob, filename: m ? m[1] : `radiomap_tx_${txIndex}.csv` };
  });
}


export interface RadioMapSampleCell {
  cellIndex: number;
  x: number;
  y: number;
  z: number;
  rssDbm: number | null;
  sinrDb: number | null;
  interferenceDbm: number | null;
  snrDb: number | null;
  associationScope?: 'all' | 'rss_serving' | 'sinr_serving';
  selectionMode?: 'strict_topk' | 'spatially_distributed';
}

export interface ChannelAnalysisTap {
  pathIndex: number;
  delayNs: number;
  receivedPowerDbm: number | null;
  phaseDeg: number | null;
}

export interface ChannelAnalysisCfr {
  frequencyOffsetHz: number[];
  magnitudeDb: (number | null)[];
  receivedPowerDbm: (number | null)[];
  phaseDeg: number[] | null;
  phaseAvailable: boolean;
  phaseNote: string;
  numRxPorts: number;
  numTxPorts: number;
}

export interface ChannelAnalysisLink {
  txIndex: number;
  txId: string;
  txName: string;
  role: 'serving' | 'dominant_interferer' | 'selected' | 'co_channel';
  channelMetrics: ChannelMetrics;
  kFactorDb: number | null;
  kFactorNote: string | null;
  maxDopplerHz: number;
  cirTaps: ChannelAnalysisTap[];
  cfr: ChannelAnalysisCfr;
  paths: PropagationPath[];
}

export interface RadioMapChannelAnalysisResponse {
  mapId: string;
  frequencyGhz: number;
  maxDepth: number;
  numSubcarriers: number;
  subcarrierSpacingHz: number;
  rxArraySize: [number, number];
  numRxPorts: number;
  numTxPorts: number;
  execution: {
    strategy: string;
    pathSolverDispatches: number;
    tracedTxRxPairs: number;
    returnedLinks: number;
    estimatedCfrComplexSamples: number;
    solveTimeMs: number;
    samplesPerSource: number;
    seed: number;
  };
  locations: Array<{
    cellIndex: number;
    positionEnuM: { x: number; y: number; z: number };
    radioMap: {
      servingTxIndex: number | null;
      servingTxName: string | null;
      rssDbm: number | null;
      topInterfererTxIndex: number | null;
    };
    links: ChannelAnalysisLink[];
  }>;
  interpretation: Record<string, string>;
}

export function getRadioMapSampleCells(
  mapId: string,
  txIndex: number,
  criterion: 'weak_sinr' | 'weak_rss' | 'strong_interference',
  limit = 16,
  associationScope: 'all' | 'rss_serving' | 'sinr_serving' = 'all',
  selectionMode: 'strict_topk' | 'spatially_distributed' = 'spatially_distributed',
): Promise<RadioMapSampleCell[]> {
  return getJson<RadioMapSampleCell[]>(
    `/api/radiomap/${encodeURIComponent(mapId)}/sector/${txIndex}/samples?criterion=${criterion}&limit=${limit}&association_scope=${associationScope}&selection_mode=${selectionMode}`,
  );
}

export function runRadioMapChannelAnalysis(
  mapId: string,
  cellIndices: number[],
  txMode: 'serving' | 'serving_and_interferer' | 'selected' | 'all',
  rxArraySize: [number, number],
  txIndex?: number,
  numSubcarriers = 64,
  subcarrierSpacingHz = 30_000,
  pathsToReturn = 24,
): Promise<RadioMapChannelAnalysisResponse> {
  return postJson<RadioMapChannelAnalysisResponse>(
    `/api/radiomap/${encodeURIComponent(mapId)}/channel-analysis`,
    { cellIndices, txMode, txIndex, rxArraySize, numSubcarriers, subcarrierSpacingHz, pathsToReturn },
  );
}


// Link-level Shannon-capacity KPIs computed from the ray-traced CFR (Tier 1 —
// pure NumPy on the backend, no PHY package). Mirrors backend LinkKpiResponse.
export interface LinkKpiCurve {
  snrDb: number[];
  openLoop: number[]; // bit/s/Hz, log2 det(I + rho/Nt·HHᴴ) — no CSIT
  beamformed: number[]; // single-stream MRT/MRC upper reference
}

export interface LinkKpiSpectrum {
  frequencyHz: number[]; // baseband subcarrier offsets (decimated)
  gainDb: number[]; // beamformed channel gain per subcarrier
  capacity: number[]; // open-loop capacity per subcarrier at the operating SNR
}

export interface LinkKpiResponse {
  reachable: boolean;
  numTxAnt: number;
  numRxAnt: number;
  numSubcarriers: number;
  bandwidthHz: number;
  noisePowerDbm: number;
  snrSource: 'link_budget' | 'override';
  rxPowerDbm: number | null;
  effectiveSnrDb: number | null;
  capacityOpenLoopBitsHz: number;
  capacityBeamformedBitsHz: number;
  capacityUniformBitsHz: number; // what the app's steered sum/sqrt(Nt) beam delivers
  throughputMbps: number;
  beamformingGainDb: number | null; // MRT vs the steered uniform beam
  conditionNumberDb: number | null;
  effectiveRank: number | null;
  spatialEigenvaluesDb: number[];
  coherenceBw50Hz: number | null; // null = flat over the measured band
  curve: LinkKpiCurve;
  spectrum: LinkKpiSpectrum;
}

export interface LinkKpiOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  noiseFigureDb: number;
  snrOverrideDb?: number | null; // null/undefined = use the link-budget SNR
}

export function solveLinkKpi(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  materials: MaterialConfig[],
  kpi: LinkKpiOptions,
): Promise<LinkKpiResponse> {
  return postJson<LinkKpiResponse>('/api/linkkpi', {
    tx,
    rx,
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    numSubcarriers: kpi.numSubcarriers,
    subcarrierSpacing: kpi.subcarrierSpacing,
    noiseFigureDb: kpi.noiseFigureDb,
    snrOverrideDb: kpi.snrOverrideDb ?? null,
  });
}

// ── Full PHY chain: NR PUSCH BER/BLER sweep (optional backend package) ──────

export interface PhyBerOptions {
  mcsIndex: number;
  mcsTable: 1 | 2 | 3;
  channelBandwidthMHz: number;
  subcarrierSpacing: number; // Hz, FR1 15/30/60 kHz
  nCellId: number; // physical cell ID, 0..1007
  cyclicPrefix: 'normal' | 'extended';
  dmrsConfigType: 1 | 2;
  dmrsAdditionalPosition: 0 | 1 | 2 | 3;
  channelMode: 'normalized' | 'absolute';
  ueTxPowerDbm: number;
  receiverNoiseFigureDb: number;
  snrMinDb: number;
  snrMaxDb: number;
  snrStepDb: number;
  slotsPerPoint: number;
}

export interface PhyBerPoint {
  ebNoDb: number;
  linkBudgetOffsetDb?: number | null;
  ber: number;
  bler: number;
  berCi95Lower: number;
  berCi95Upper: number;
  blerCi95Lower: number;
  blerCi95Upper: number;
  goodputMbps: number;
  bitErrors: number;
  bits: number;
  blockErrors: number;
  blocks: number;
}

export interface PhyBerResult {
  points: PhyBerPoint[];
  mcsIndex: number;
  mcsTable: number;
  modulationOrder: number;
  targetCoderate: number;
  numPrb: number;
  numSubcarriers: number;
  subcarrierSpacingHz: number;
  channelBandwidthMHz: number | null;
  occupiedBandwidthHz: number;
  nCellId: number;
  cyclicPrefix: string;
  dmrsConfigType: number;
  dmrsAdditionalPosition: number;
  numSymbolsPerSlot: number;
  slotDurationSeconds: number;
  maxExcessDelayNs: number;
  approxMinimumCpNs: number;
  channelNormalized: boolean;
  channelDirection: string;
  interferenceModel: string;
  numRxAnt: number; // base-station elements (reciprocal uplink receive side)
  numTxAnt: number; // effective PUSCH streams
  numUeArrayPorts: number; // physical UE ports under the uniform precoder
  numPaths: number;
  slotsPerPoint: number;
  transportBlockBits: number;
  seed: number;
  channelMode: 'normalized' | 'absolute';
  sweepAxis: 'ebno' | 'link_budget_offset';
  linkBudgetEbNoDb?: number | null;
  effectiveSnrDb?: number | null;
  rxPowerDbm?: number | null;
  noisePowerDbm?: number | null;
  noiseBandwidthHz?: number | null;
  meanChannelGainDb?: number | null;
  ueTxPowerDbm?: number | null;
  receiverNoiseFigureDb?: number | null;
  noiseTemperatureK?: number | null;
}

export interface PhyBerJobStatus {
  jobId: string;
  status: 'running' | 'cancelling' | 'done' | 'error' | 'cancelled';
  progress: number; // 0..1
  message: string;
  result?: PhyBerResult | null;
}

// Whether the backend has the optional Sionna PHY package installed.
export async function checkPhyAvailable(): Promise<boolean> {
  try {
    return await withRequestTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const res = await fetch('/api/health', { signal });
      if (!res.ok) return false;
      return Boolean((await res.json()).phy);
    });
  } catch {
    return false;
  }
}

/** Start a BER/BLER-vs-Eb/N0 sweep of the link through the 5G NR PUSCH chain
 * (background job on the backend — poll with getPhyBerStatus). */
export function startPhyBerSweep(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  materials: MaterialConfig[],
  phy: PhyBerOptions,
): Promise<PhyBerJobStatus> {
  return postJson<PhyBerJobStatus>('/api/phyber', {
    tx, rx, buildings, freqGhz, maxDepth, options, materials, ...phy,
  });
}

export async function getPhyBerStatus(jobId: string): Promise<PhyBerJobStatus> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`/api/phyber/${jobId}`, { signal });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as PhyBerJobStatus;
  });
}

export type CIRFormat = 'npz' | 'cir_npz' | 'cir_csv' | 'cfr_csv';

export interface CIRExportOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  normalizeDelays: boolean;
}

export interface CIRDeviceSelection {
  txs: Transmitter[];
  rxs: Receiver[];
}

/**
 * Export native Sionna channel tensors for either the selected Tx→Rx link or
 * every device in one scene/PathSolver dispatch. Multi-device NPZ tensors keep
 * [num_rx, num_rx_ant, num_tx, num_tx_ant, ...] axis order.
 */
export function exportCIR(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  format: CIRFormat,
  cir: CIRExportOptions,
  materials: MaterialConfig[] = [],
  devices?: CIRDeviceSelection,
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/cir', {
    ...(devices ? { txs: devices.txs, rxs: devices.rxs } : { tx, rx }),
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    format,
    numSubcarriers: cir.numSubcarriers,
    subcarrierSpacing: cir.subcarrierSpacing,
    normalizeDelays: cir.normalizeDelays,
  }, 'sionna_rt_studio_cir.bin');
}

/**
 * Retrace every Tx→Rx pair independently and download one ZIP. This preserves
 * heterogeneous array sizes because each NPZ contains its pair's native CIR
 * tensor instead of forcing every device onto one scene-wide array.
 */
export function exportCIRBundle(
  txs: Transmitter[],
  rxs: Receiver[],
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  normalizeDelays: boolean,
  materials: MaterialConfig[] = [],
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/cir-bundle', {
    txs,
    rxs,
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    normalizeDelays,
    format: 'cir_npz',
  }, 'sionna_rt_studio_cir_all_pairs.zip');
}

export interface SceneExportOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  normalizeDelays: boolean;
}

/**
 * Download the traced scene as a standalone Sionna RT project: the Mitsuba
 * `scene.xml` + `meshes/*.ply` the backend actually ray-traces, plus a generated
 * `load_scene.py` that replays the Python-side setup (frequency, material
 * overrides, exact PlanarArray groups, devices, PathSolver switches) so the
 * same solve(s) run in a plain notebook.
 */
export function exportScene(
  txs: Transmitter[],
  rxs: Receiver[],
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  scene: SceneExportOptions,
  materials: MaterialConfig[] = [],
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/scene-export', {
    txs,
    rxs,
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    numSubcarriers: scene.numSubcarriers,
    subcarrierSpacing: scene.subcarrierSpacing,
    normalizeDelays: scene.normalizeDelays,
  }, 'sionna_rt_studio_scene.zip');
}

export interface ChannelGridExportOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  normalizeDelays: boolean;
}

/**
 * Ray-traced channel-grid export. Every radio-map cell is retraced on the
 * backend and the full per-Rx/per-Tx-port CFR (`paths.cfr()`) is returned as a
 * NumPy `.npz`. `cells` are the radio-map cell centers (ENU); all of those
 * virtual receivers share the active receiver's scene.rx_array.
 */
export function exportChannelGrid(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  cells: { x: number; y: number; z: number }[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  gridOptions: ChannelGridExportOptions,
  materials: MaterialConfig[] = [],
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/channel-grid', {
    tx,
    rx,
    buildings,
    cells,
    freqGhz,
    maxDepth,
    options,
    materials,
    numSubcarriers: gridOptions.numSubcarriers,
    subcarrierSpacing: gridOptions.subcarrierSpacing,
    normalizeDelays: gridOptions.normalizeDelays,
  }, 'sionna_rt_studio_channel_grid.npz');
}

// Ray-traces every transmitter in `txs` to each waypoint. `combineMode` chooses
// how the per-step KPIs collapse the transmitters: 'best_server' = strongest Tx
// (instantaneous serving-cell association), 'sum' = total incident power over all Tx. Rays are the union either
// way; each step carries the serving Tx (best_server only) + a per-Tx breakdown.
export function solveMobility(
  txs: Transmitter[],
  rx: Receiver,
  buildings: BuildingFootprint[],
  waypoints: { x: number; y: number; z: number }[],
  freqGhz: number,
  speedKmh: number,
  maxDepth: number,
  options: SolverOptions = DEFAULT_SOLVER_OPTIONS,
  materials: MaterialConfig[] = [],
  combineMode: MobilityCombineMode = 'best_server',
  executionMode: 'auto' | 'batched' | 'serial_reference' = 'auto',
  handover?: HandoverConfig,
): Promise<MobilityResponse> {
  return postJson<MobilityResponse>('/api/mobility', {
    txs,
    rx,
    buildings,
    waypoints,
    freqGhz,
    speedKmh,
    maxDepth,
    options,
    materials,
    combineMode,
    executionMode,
    ...(handover ? { handover } : {}),
  });
}

// ── Field measurement import and quality control ───────────────────────────
export interface MeasurementPciCount {
  pci: string;
  count: number;
}

export interface MeasurementMetricStats {
  count: number;
  mean: number;
  std: number;
  min: number;
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
}

export interface MeasurementSummary {
  filename: string;
  totalRows: number;
  columnCount: number;
  columns: string[];
  delimiter: string;
  timestampStartUtc: string | null;
  timestampEndUtc: string | null;
  durationSeconds: number | null;
  intervalSeconds: MeasurementMetricStats | null;
  radioValidRows: number;
  radioInvalidRows: number;
  locationValidRows: number;
  gpsCoveragePercent: number;
  eligibleForSpatialValidationRows: number;
  nrRows: number;
  lteRows: number;
  otherRatRows: number;
  uniquePciCount: number;
  pciCounts: MeasurementPciCount[];
  ratCounts: { rat: string; count: number }[];
  bandCounts: { band: string; count: number }[];
  arfcnCounts: { arfcn: string; count: number }[];
  positionSources: { source: string; count: number }[];
  duplicateTimestampGroups: number;
  duplicateTimestampExtraRows: number;
  latitudeBounds: { min: number; max: number } | null;
  longitudeBounds: { min: number; max: number } | null;
  rsrpAllValid: MeasurementMetricStats | null;
  rsrpNrValid: MeasurementMetricStats | null;
  rsrqNrValid: MeasurementMetricStats | null;
  sinrNrValid: MeasurementMetricStats | null;
  qualityFlagCounts: Record<string, number>;
  warnings: string[];
}

export interface MeasurementDataset {
  datasetId: string;
  filename: string;
  columns: string[];
  summary: MeasurementSummary;
  preview: Record<string, unknown>[];
}

export interface MeasurementDatasetListItem {
  datasetId: string;
  filename: string;
  totalRows: number;
  radioValidRows: number;
  locationValidRows: number;
}

export interface MeasurementRowsResponse {
  total: number;
  offset: number;
  limit: number;
  rows: {
    rowIndex: number;
    raw: Record<string, string>;
    quality: {
      timestampUtc: string | null;
      rat: string | null;
      pci: number | null;
      band: number | null;
      arfcn: number | null;
      rsrpDbm: number | null;
      rsrqDb: number | null;
      sinrDb: number | null;
      rssiDbm: number | null;
      lat: number | null;
      lon: number | null;
      altitudeM: number | null;
      positionSource: string | null;
      radioValid: boolean;
      locationValid: boolean;
      eligibleForSpatialValidation: boolean;
      qualityFlags: string[];
    };
  }[];
}

export async function importMeasurementCsv(file: File): Promise<MeasurementDataset> {
  const text = await file.text();
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const url = `/api/measurements/import?filename=${encodeURIComponent(file.name)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: text,
      signal,
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as MeasurementDataset;
  });
}

export function listMeasurementDatasets(): Promise<{ datasets: MeasurementDatasetListItem[] }> {
  return getJson('/api/measurements');
}

export function getMeasurementDataset(datasetId: string): Promise<MeasurementDataset> {
  return getJson(`/api/measurements/${encodeURIComponent(datasetId)}`);
}

export function getMeasurementRows(
  datasetId: string,
  options: { rat?: string; pci?: number; validOnly?: boolean; spatialOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<MeasurementRowsResponse> {
  const query = new URLSearchParams();
  if (options.rat) query.set('rat', options.rat);
  if (options.pci != null) query.set('pci', String(options.pci));
  if (options.validOnly) query.set('valid_only', 'true');
  if (options.spatialOnly) query.set('spatial_only', 'true');
  query.set('limit', String(options.limit ?? 100));
  query.set('offset', String(options.offset ?? 0));
  return getJson(`/api/measurements/${encodeURIComponent(datasetId)}/rows?${query.toString()}`);
}

export async function exportMeasurementCsv(
  datasetId: string,
  spatialOnly = false,
): Promise<{ blob: Blob; filename: string }> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(
      `/api/measurements/${encodeURIComponent(datasetId)}/export.csv?spatial_only=${spatialOnly ? 'true' : 'false'}`,
      { signal },
    );
    if (!res.ok) throw new Error(await errorDetail(res));
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^";]+)"?/i);
    return { blob, filename: match?.[1] || 'measurements_qc.csv' };
  });
}


export interface MeasurementSceneBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface MeasurementGeospatialAuditRequest {
  anchorLatitude: number;
  anchorLongitude: number;
  sceneBounds?: MeasurementSceneBounds | null;
}

export interface MeasurementGeospatialAudit {
  datasetId: string;
  filename: string;
  sourceCrs: string;
  sceneCoordinateSystem: string;
  metricProjectedCrs: string;
  metricProjectedCrsApplicable: boolean;
  anchor: { latitude: number; longitude: number };
  sceneBounds: MeasurementSceneBounds | null;
  sceneBoundsMeaning: string;
  totalRows: number;
  locationRows: number;
  eligibleForSpatialValidationRows: number;
  withinSceneEnvelopeRows: number | null;
  outsideSceneEnvelopeRows: number | null;
  withinSceneEnvelopeEligibleRows: number | null;
  outsideSceneEnvelopeEligibleRows: number | null;
  anchorInsideSceneEnvelope: boolean | null;
  gpsCentroidEnu: { eastM: number | null; northM: number | null };
  gpsCentroidDistanceFromAnchorM: number | null;
  sceneEnuBoundsOfMeasurements: { eastMinM: number; eastMaxM: number; northMinM: number; northMaxM: number } | null;
  utm34nBounds: { eastingMinM: number; eastingMaxM: number; northingMinM: number; northingMaxM: number } | null;
  anchorDistanceStatsM: Record<string, number> | null;
  gpsAltitudeStatsM: Record<string, number> | null;
  distinctGpsPositions: number;
  warnings: string[];
  preview: Array<Record<string, number | boolean | null>>;
}

export function runMeasurementGeospatialAudit(
  datasetId: string,
  request: MeasurementGeospatialAuditRequest,
): Promise<MeasurementGeospatialAudit> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`/api/measurements/${encodeURIComponent(datasetId)}/geospatial-audit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal,
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as MeasurementGeospatialAudit;
  });
}


export interface MeasurementRadioIdentityProfile {
  profileId: string;
  rat: string;
  pci: number;
  band: number | null;
  arfcn: number | null;
  lteAnchorCellId: string | null;
  lteAnchorPci: number | null;
  lteAnchorBand: string | null;
  lteAnchorEarfcn: number | null;
  rowCount: number;
  eligibleRows: number;
  distinctGpsPositions: number;
  rsrpMedianDbm: number | null;
  rsrpP05Dbm: number | null;
  rsrpP95Dbm: number | null;
  sinrMedianDb: number | null;
  firstTimestampUtc: string | null;
  lastTimestampUtc: string | null;
  lteAnchorContexts?: Array<{ cellId: string; pci: number | null; earfcn: number | null; count: number }>;
}

export interface MeasurementTxCandidate {
  txId: string;
  txName: string;
  site?: string | null;
  frequencyBand?: string | null;
  carrierFrequencyGhz?: number | null;
  txEastM?: number;
  txNorthM?: number;
  measurementPointCount?: number;
  distanceAvailable: boolean;
  distanceMinM?: number | null;
  distanceP50M?: number | null;
  distanceP90M?: number | null;
  distanceMaxM?: number | null;
  measurementBearingMeanDeg?: number | null;
  beamAzimuthDeg?: number | null;
  boresightDeltaDeg?: number | null;
  frequencyBandMatch?: boolean | null;
  rankingMeaning?: string;
  warning?: string;
}

export interface MeasurementMatchingAuditRequest {
  anchorLatitude: number;
  anchorLongitude: number;
  sceneBounds?: MeasurementSceneBounds | null;
  transmitters: Transmitter[];
  rat?: string | null;
  profileId?: string | null;
  pci?: number | null;
  band?: number | null;
  arfcn?: number | null;
  previewLimit?: number;
}

export interface MeasurementMatchingAudit {
  datasetId: string;
  filename: string;
  anchor?: { latitude: number; longitude: number };
  sceneBounds?: MeasurementSceneBounds | null;
  identityProfiles: MeasurementRadioIdentityProfile[];
  totalIdentityProfiles?: number;
  selectedProfile: MeasurementRadioIdentityProfile | null;
  candidateTransmitters: MeasurementTxCandidate[];
  preview: Array<Record<string, string | number | boolean | null>>;
  warnings: string[];
}

export function runMeasurementMatchingAudit(
  datasetId: string,
  request: MeasurementMatchingAuditRequest,
): Promise<MeasurementMatchingAudit> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`/api/measurements/${encodeURIComponent(datasetId)}/matching-audit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal,
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as MeasurementMatchingAudit;
  });
}


export interface MeasurementRayTraceRequest {
  anchorLatitude: number;
  anchorLongitude: number;
  sceneBounds?: MeasurementSceneBounds | null;
  profileId: string;
  tx: Transmitter;
  buildings: BuildingFootprint[];
  freqGhz: number;
  maxDepth: number;
  options: SolverOptions;
  materials: MaterialConfig[];
  rxHeightM: number;
  sampleCount: number;
  rxArraySize: [number, number];
}

export interface MeasurementRayTraceRow {
  sampleIndex: number;
  sourceRows: number[];
  sourceRowCount: number;
  firstTimestampUtc: string | null;
  lastTimestampUtc: string | null;
  latitude: number;
  longitude: number;
  eastM: number;
  northM: number;
  rxHeightAglM: number;
  measuredRsrpMedianDbm: number | null;
  measuredRsrqMedianDb: number | null;
  measuredSinrMedianDb: number | null;
  simulatedTotalRxPowerDbm: number | null;
  simulatedChannelGainDb: number | null;
  losStatus: 'LOS' | 'NLOS';
  numPaths: number;
  rmsDelaySpreadNs: number;
  strongestPathPowerDbm: number | null;
  strongestPathType: string;
  maxDopplerHz: number;
  withinSceneEnvelope: boolean | null;
  simulationValid: boolean;
  configurationFingerprint: string;
}

export interface MeasurementRfConfiguration {
  schemaVersion: string;
  configurationFingerprint: string;
  physicalCalibrationStatus: string;
  physicalCalibrationWarnings: string[];
  frequency: { effectiveGhz: number; source: string; applicationGhz: number; measurementArfcn: number | null };
  tx: {
    id: string; name: string; site: string | null; transmitterLabel?: string | null;
    frequencyBand?: string | null; carrierFrequencyGhzMetadata?: number | null; sourcePowerDbmMetadata?: number | null;
    positionEnuM: { east: number; north: number; up: number };
    configuredHeightM: number; heightReferenceInput: string | null; heightResolution: string;
    powerDbm: number; powerReference: string | null;
    antennaModelMetadata: string | null; antennaModelMetadataAppliedAsCustomPattern: boolean;
    antennaGainDbiMetadata: number | null; antennaGainDbiMetadataAppliedSeparately: boolean;
    arraySize: number[]; arrayPorts: number; pattern: string; polarization: string;
    elementSpacingLambda: number; beamAzimuthDeg: number; beamElevationDeg: number;
    mechanicalDowntiltDegMetadata: number | null; electricalDowntiltDegMetadata: number | null; panelDowntiltMetadataAppliedToBeam: boolean;
  };
  rx: { heightAglM: number; arraySize: number[]; arrayPorts: number; pattern: string; polarization: string; elementSpacingLambda: number };
  pathSolver: {
    maxDepth: number; pathSamplesPerSource: number; pathSeed: number;
    los: boolean; specularReflection: boolean; diffuseReflection: boolean;
    refraction: boolean; diffraction: boolean; edgeDiffraction: boolean; syntheticArray: boolean;
  };
  scene: { geometryFingerprint: string; buildingCount: number; buildingMaterialCounts: Record<string, number>; materialOverrides: MaterialConfig[]; anchorLatitude: number; anchorLongitude: number; sceneBounds: MeasurementSceneBounds | null };
  sampling: { sampleCountRequested: number; sampleCountReturned: number; rxHeightAglM: number; strategy: string };
}

export interface MeasurementRayTraceResult {
  datasetId: string;
  filename: string;
  profile: {
    profileId: string; rat: string; pci: number; band: number | null;
    arfcn: number | null; lteAnchorCellId: string | null;
    lteAnchorPci: number | null; eligibleRows: number;
  };
  transmitter: {
    txId: string; txName: string; site: string | null;
    frequencyBand: string | null; inventoryCarrierFrequencyGhz: number | null;
    txPowerDbm: number; powerReference: string | null; antennaGainDbi: number | null;
    beamAzimuthDeg: number; txPositionEnuM: { east: number; north: number; up: number };
  };
  frequencyGhz: number;
  frequencySource: string;
  configuredApplicationFrequencyGhz: number;
  maxDepth: number;
  rxHeightAglM: number;
  rxArraySize: number[];
  rfConfiguration: MeasurementRfConfiguration;
  configurationFingerprint: string;
  sampleStrategy: string;
  allDistinctEligiblePositions: number;
  eligiblePositionsInsideScene: number;
  excludedOutsideScenePositions: number;
  sampleCountRequested: number;
  sampleCountReturned: number;
  validSimulationCount: number;
  noPathCount: number;
  medianSimulatedTotalRxPowerDbm: number | null;
  medianSimulatedChannelGainDb: number | null;
  medianMeasuredRsrpDbm: number | null;
  results: MeasurementRayTraceRow[];
  warnings: string[];
}

export function runMeasurementRayTraceSamples(
  datasetId: string,
  request: MeasurementRayTraceRequest,
): Promise<MeasurementRayTraceResult> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`/api/measurements/${encodeURIComponent(datasetId)}/raytrace-samples`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal,
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as MeasurementRayTraceResult;
  });
}

export async function exportGeoreferencedMeasurementCsv(
  datasetId: string,
  request: MeasurementGeospatialAuditRequest,
): Promise<{ blob: Blob; filename: string }> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`/api/measurements/${encodeURIComponent(datasetId)}/georeferenced.csv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal,
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^";]+)"?/i);
    return { blob, filename: match?.[1] || 'measurements_georeferenced.csv' };
  });
}

// ── Persistent experiments, RF presets and cancellable jobs ────────────────
export type ExperimentStatus = 'running' | 'done' | 'error' | 'cancelled';
export interface ExperimentReplay {
  endpoint: string;
  body: Record<string, unknown>;
  description?: string;
}
export interface ExperimentRun {
  id: string;
  name: string;
  kind: string;
  status: ExperimentStatus;
  startedAtUtc: string;
  completedAtUtc: string | null;
  durationMs: number | null;
  configurationFingerprint: string;
  configuration: Record<string, unknown>;
  seed: number | null;
  parameters: Record<string, unknown>;
  results: Record<string, unknown>;
  error: string | null;
  replay: ExperimentReplay | null;
}
export interface ExperimentCreateInput {
  name: string;
  kind: string;
  status?: ExperimentStatus;
  startedAtUtc?: string;
  completedAtUtc?: string;
  durationMs?: number;
  configurationFingerprint?: string;
  seed?: number | null;
  configuration: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  results?: Record<string, unknown>;
  error?: string | null;
  replay?: ExperimentReplay | null;
}
export interface ExperimentUpdateInput {
  status?: ExperimentStatus;
  configurationFingerprint?: string;
  completedAtUtc?: string;
  durationMs?: number;
  results?: Record<string, unknown>;
  error?: string | null;
  replay?: ExperimentReplay | null;
}
export interface ConfigurationPreset {
  id: string;
  name: string;
  description: string;
  configuration: Record<string, any>;
  configurationFingerprint: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export function createExperimentRecord(input: ExperimentCreateInput): Promise<ExperimentRun> {
  return postJson<ExperimentRun>('/api/experiments', input);
}
export async function updateExperimentRecord(id: string, input: ExperimentUpdateInput): Promise<ExperimentRun> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`/api/experiments/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), signal,
    });
    if (!response.ok) throw new Error(await errorDetail(response));
    return await response.json() as ExperimentRun;
  });
}
export async function listExperimentRecords(limit = 300): Promise<ExperimentRun[]> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`/api/experiments?limit=${limit}`, { signal });
    if (!response.ok) throw new Error(await errorDetail(response));
    return (await response.json() as { experiments: ExperimentRun[] }).experiments;
  });
}
export async function deleteExperimentRecord(id: string): Promise<void> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`/api/experiments/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
    if (!response.ok) throw new Error(await errorDetail(response));
  });
}
export async function listConfigurationPresets(): Promise<ConfigurationPreset[]> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch('/api/configuration-presets', { signal });
    if (!response.ok) throw new Error(await errorDetail(response));
    return (await response.json() as { presets: ConfigurationPreset[] }).presets;
  });
}
export function createConfigurationPreset(input: {
  name: string; description?: string; configuration: Record<string, unknown>;
}): Promise<ConfigurationPreset> {
  return postJson<ConfigurationPreset>('/api/configuration-presets', input);
}
export async function deleteConfigurationPreset(id: string): Promise<void> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`/api/configuration-presets/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
    if (!response.ok) throw new Error(await errorDetail(response));
  });
}

export interface MeasurementRayTraceJobStatus {
  jobId: string;
  status: 'running' | 'cancelling' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  result?: MeasurementRayTraceResult | null;
}
export function startMeasurementRayTraceJob(
  datasetId: string, request: MeasurementRayTraceRequest,
): Promise<MeasurementRayTraceJobStatus> {
  return postJson<MeasurementRayTraceJobStatus>(
    `/api/measurements/${encodeURIComponent(datasetId)}/raytrace-jobs`, request,
  );
}
export async function getMeasurementRayTraceJob(jobId: string): Promise<MeasurementRayTraceJobStatus> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`/api/measurement-raytrace-jobs/${encodeURIComponent(jobId)}`, { signal });
    if (!response.ok) throw new Error(await errorDetail(response));
    return await response.json() as MeasurementRayTraceJobStatus;
  });
}
export async function cancelMeasurementRayTraceJob(jobId: string): Promise<MeasurementRayTraceJobStatus> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`/api/measurement-raytrace-jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', signal });
    if (!response.ok) throw new Error(await errorDetail(response));
    return await response.json() as MeasurementRayTraceJobStatus;
  });
}
export async function cancelPhyBerJob(jobId: string): Promise<PhyBerJobStatus> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`/api/phyber/${encodeURIComponent(jobId)}`, { method: 'DELETE', signal });
    if (!response.ok) throw new Error(await errorDetail(response));
    return await response.json() as PhyBerJobStatus;
  });
}
