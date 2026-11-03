// Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
// Upstream: https://github.com/puloktarafder/SionnaRTStudio

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GeoAnchor {
  latitude: number;
  longitude: number;
}

export interface ENUVector {
  x: number; // East (meters)
  y: number; // North (meters)
  z: number; // Up (meters)
}

/** One original modem record represented by a 3D measurement marker.
 * Raw WGS84 coordinates are retained; the scene reprojects them whenever its
 * anchor changes. GPS altitude is intentionally not used.
 */
export interface MeasurementOverlaySample {
  rowIndex: number;
  timestampUtc: string | null;
  rat: string;
  pci: number | null;
  band: number | null;
  arfcn: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  sinrDb: number | null;
  rssiDbm: number | null;
  radioValid: boolean;
  locationValid: boolean;
  qualityFlags: string[];
}

/** Georeferenced field-measurement point for the 3D scene overlay.
 * In unique-location mode, samples contains every original modem row at the
 * same GPS coordinate and the RF values are medians. In individual modes,
 * every point represents exactly one source row.
 */
export interface MeasurementOverlayPoint {
  id: string;
  latitude: number;
  longitude: number;
  rsrpDbm: number | null;
  sinrDb: number | null;
  sampleCount: number;
  pci: number | null;
  rat: string;
  samples: MeasurementOverlaySample[];
}

export interface BuildingFootprint {
  id: string;
  /** OSM feature label, primarily used for named roads in the 3D map. */
  name?: string;
  points: { lat: number; lon: number }[];
  enuPoints: ENUVector[];
  height: number;
  levels?: number;
  category: 'building' | 'infrastructure' | 'terrain' | 'water';
  type: string;
  material: string; // e.g., 'itu_concrete', 'itu_glass', 'itu_brick'
}

export interface Transmitter {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  height: number; // metres, interpreted using heightReference when provided
  enu: ENUVector;
  powerDbm: number; // conducted TX power supplied to Sionna RT
  antennaArraySize: [number, number]; // [horizontal, vertical]
  beamsteeringAzimuth: number; // degrees clockwise from North
  beamsteeringElevation: number; // degrees above horizon; negative = downtilt
  // Optional base-station metadata. Legacy/manual TX objects remain valid.
  site?: string;
  transmitterLabel?: string;
  antennaModel?: string;
  frequencyBand?: string;
  carrierFrequencyGhz?: number; // exact DL carrier, only when actually known
  sourcePowerDbm?: number;
  powerReference?: 'conducted' | 'eirp';
  antennaGainDbi?: number;
  heightReference?: 'agl' | 'roof' | 'scene_z';
  mechanicalDowntiltDeg?: number;
  electricalDowntiltDeg?: number;
}

export interface Receiver {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  height: number;
  enu: ENUVector;
  antennaArraySize: [number, number];
}

export type InteractionKind = 'specular' | 'diffuse' | 'refraction' | 'diffraction' | 'other';

export interface PropagationPath {
  id: string;
  points: ENUVector[]; // path segments: Tx -> P1 -> P2 -> ... -> Rx
  type: 'LOS' | 'Reflection' | 'Diffraction' | 'NLOS';
  order: number; // 0 for LOS, 1 for single bounce, etc.
  distance: number; // total meters
  pathLossDb: number;
  receivedPowerDbm: number;
  delayNs: number;
  phasesRad: number[]; // phase shifts at each interaction
  materialsReached: string[];
  // Exact per-bounce interaction types from Sionna paths.interactions.
  interactionKinds?: InteractionKind[];
  // Angles of departure (Tx) / arrival (Rx), degrees. Azimuth clockwise from
  // North (0=N, 90=E); elevation above the horizon.
  aodAzimuthDeg?: number | null;
  aodElevationDeg?: number | null;
  aoaAzimuthDeg?: number | null;
  aoaElevationDeg?: number | null;
  // Which transmitter this ray departs from — set when several Tx are solved at
  // once (multi-Tx mobility), so the scene can tell each transmitter's rays apart.
  txId?: string | null;
}

export interface ChannelMetrics {
  totalRxPowerDbm: number;
  losStatus: 'LOS' | 'NLOS';
  numPaths: number;
  rmsDelaySpreadNs: number;
  rmsDelaySpreadValid?: boolean;
  strongestPathPowerDbm: number;
  strongestPathType: string;
}

export type CoverageMetric = 'power' | 'path_gain' | 'path_loss' | 'sinr' | 'best_sinr' | 'interference' | 'sir' | 'inr' | 'dominance';

// How multi-Tx mobility collapses every transmitter into each waypoint's KPIs:
// 'best_server' = strongest-Tx association; 'sum' = non-coherent total incident
// power over all Tx. A cross-Tx delay spread is undefined in the latter mode.
export type MobilityCombineMode = 'best_server' | 'sum';

export interface RadioMapCell {
  x: number;
  y: number;
  z: number;
  powerDbm: number; // native Sionna RSS for the strongest-RSS sector [dBm]
  isLos?: boolean | null; // RadioMapSolver does not expose per-cell LOS; null = unknown
  sinr?: number | null; // native Sionna SINR for the strongest-RSS sector [dB]
  servingTx?: number | null;
  bestSinrTx?: number | null;
  bestSinrDb?: number | null; // highest per-TX SINR; can differ from RSS-serving sector
  bestPathGainTx?: number | null;
  pathGainDb?: number | null; // strongest native Sionna path_gain, independent of TX power
  effectivePathLossDb?: number | null; // derived negative path gain, includes TX pattern/array
  competingSectorCount?: number | null;
  interferencePowerDbm?: number | null; // derived sum of other co-channel TX RSS [dBm]
  sirDb?: number | null; // derived signal/interference ratio [dB]
  inrDb?: number | null; // derived interference/noise ratio [dB]
  dominanceMarginDb?: number | null; // best RSS - second-best RSS [dB]
  topInterfererTx?: number | null;
  topInterfererPowerDbm?: number | null;
  topInterferenceSharePercent?: number | null;
  metricValue?: number | null; // selected display metric
}

export interface CdfPoint {
  percentile: number;
  value: number;
}

export interface HistogramBin {
  binStart: number;
  binEnd: number;
  count: number;
  percent: number;
}

export interface CoverageStats {
  metric: CoverageMetric;
  unit: string;
  thresholdDb: number;
  thresholdComparison?: 'at_or_above' | 'at_or_below';
  servedPercent: number;
  outagePercent: number;
  reachablePercent: number;
  servedAreaKm2: number;
  totalAreaKm2: number;
  cellAreaM2: number;
  count: number;
  reachableCount: number;
  mean?: number | null;
  std?: number | null;
  p5?: number | null;
  p10?: number | null;
  p25?: number | null;
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
  p95?: number | null;
  minVal?: number | null;
  maxVal?: number | null;
  cdf?: CdfPoint[];
  histogram?: HistogramBin[];
  meanRssDbm?: number | null;
  meanPathGainDb?: number | null;
  meanSinrDb?: number | null;
  meanBestSinrDb?: number | null;
  meanInterferenceDbm?: number | null;
  overlapPercent?: number;
  meanCompetingSectors?: number;
  noisePowerDbm?: number | null;
  overlapRssThresholdDbm: number;
}

export interface TransmitterRadioStats {
  txIndex: number;
  txId: string;
  txName: string;
  site?: string | null;
  frequencyBand?: string | null;
  powerDbm?: number | null;
  meanRssDbm?: number | null;
  rssP5Dbm?: number | null;
  rssP50Dbm?: number | null;
  rssP95Dbm?: number | null;
  meanSinrDb?: number | null;
  sinrP5Db?: number | null;
  sinrP50Db?: number | null;
  sinrP95Db?: number | null;
  meanPathGainDb?: number | null;
  servingCellCount: number;
  servingPercent: number;
  rssCoverageThresholdDbm: number;
  rssCoveragePercent: number;
  rssCoverageAreaKm2: number;
  sinrCoverageThresholdDb: number;
  sinrCoveragePercent: number;
  sinrCoverageAreaKm2: number;
  rssStdDb?: number | null;
  rssMinDbm?: number | null;
  rssMaxDbm?: number | null;
  rssP10Dbm?: number | null;
  rssP25Dbm?: number | null;
  rssP75Dbm?: number | null;
  rssP90Dbm?: number | null;
  sinrStdDb?: number | null;
  sinrMinDb?: number | null;
  sinrMaxDb?: number | null;
  sinrP10Db?: number | null;
  sinrP25Db?: number | null;
  sinrP75Db?: number | null;
  sinrP90Db?: number | null;
  pathGainP5Db?: number | null;
  pathGainP50Db?: number | null;
  pathGainP95Db?: number | null;
  meanSnrDb?: number | null;
  meanInterferenceDbm?: number | null;
  meanSirDb?: number | null;
  meanInrDb?: number | null;
  sinrAssociationCellCount?: number;
  sinrAssociationPercent?: number;
  pathGainAssociationCellCount?: number;
  pathGainAssociationPercent?: number;
  rssReachablePercent?: number;
  topInterfererCells?: number;
  topInterfererCellPercent?: number;
  meanTopInterferenceDbm?: number | null;
  meanTopInterferenceSharePercent?: number;
  leaveOneOut?: LeaveOneOutStats | null;
}

export interface LeaveOneOutStats {
  txIndex: number;
  txId: string;
  txName: string;
  cellsRemovedWasServing: number;
  cellsWithAlternateServer: number;
  rssCoveragePercent: number;
  rssCoverageDeltaPp: number;
  sinrCoveragePercent: number;
  sinrCoverageDeltaPp: number;
  meanSinrDb?: number | null;
  meanSinrDeltaDb?: number | null;
  outagePercent: number;
  servedAreaKm2: number;
}

export interface SiteRadioStats {
  site: string;
  sectorCount: number;
  meanRssDbm?: number | null;
  meanSinrDb?: number | null;
  meanPathGainDb?: number | null;
  rssP5Dbm?: number | null;
  rssP50Dbm?: number | null;
  rssP95Dbm?: number | null;
  servingCellCount: number;
  servingPercent: number;
  rssCoveragePercent: number;
  rssCoverageAreaKm2: number;
  sinrCoveragePercent: number;
  sinrCoverageAreaKm2: number;
}

export interface SectorAnalysisResponse {
  txIndex: number;
  transmitter: Record<string, unknown>;
  associations: { rss: number; sinr: number; pathGain: number };
  associationSharePercent: { rss: number; sinr: number; pathGain: number };
  noisePowerDbm?: number | null;
  summaries: Record<string, CoverageStats>;
  radialProfile: Array<{
    distanceStartM: number;
    distanceEndM: number;
    cellCount: number;
    meanRssDbm?: number | null;
    meanSinrDb?: number | null;
  }>;
  interpretation: Record<string, string>;
}

export interface DominantInterferencePair {
  victimTxIndex: number;
  victimTxId: string;
  victimTxName: string;
  victimSite?: string | null;
  interfererTxIndex: number;
  interfererTxId: string;
  interfererTxName: string;
  interfererSite?: string | null;
  siteRelation: 'intra_site' | 'inter_site' | 'unknown_site';
  cells: number;
  victimServingCells: number;
  shareOfVictimCellsPercent: number;
  meanDominantInterferenceDbm: number;
  meanInterferenceSharePercent: number;
  meanSinrGainIfRemovedDb: number;
  rankScope: string;
}

export interface DominantInterferenceMatrix {
  topK: number;
  sectorCount: number;
  servingCellCounts: number[];
  pairs: DominantInterferencePair[];
  siteRelationCounts?: { intra_site: number; inter_site: number; unknown_site: number };
  definition: string;
}

export interface RadioMapGrid {
  cells: RadioMapCell[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  gridSize: number;
  heightOffset: number;
  metric?: CoverageMetric;
  unit?: string;
  stats?: CoverageStats | null;
  txStats?: TransmitterRadioStats[];
  siteStats?: SiteRadioStats[];
  associationStats?: {
    rss?: Array<{ txIndex: number; txId: string; txName: string; cells: number; percentOfAllCells: number }>;
    sinr?: Array<{ txIndex: number; txId: string; txName: string; cells: number; percentOfAllCells: number }>;
    pathGain?: Array<{ txIndex: number; txId: string; txName: string; cells: number; percentOfAllCells: number }>;
    unassociatedRssCells?: number;
    unassociatedSinrCells?: number;
    unassociatedPathGainCells?: number;
    method?: string;
  } | null;
  mapId?: string | null;
  /** WGS84 anchor captured when this radio-map was solved; never infer it from a later UI anchor. */
  geoReference?: {
    crs: 'EPSG:4326';
    anchor: GeoAnchor;
    method: 'WGS84_LOCAL_TANGENT_ENU';
    note: string;
  } | null;
  noisePowerDbm?: number | null;
  simulationConfig?: Record<string, unknown> | null;
  samplesPerTx?: number;
  seed?: number;
}

// OFDM grid for coverage-proxy and ray-traced channel-grid exports.
export interface ChannelGridConfig {
  numSubcarriers: number;
  bandwidthMhz: number;
}

// One drawn/generated waypoint of the receiver's mobility trajectory.
export interface TrajectoryPoint {
  lat: number;
  lon: number;
  enu: ENUVector;
}

// One solved Tx→Rx pair in the all-pairs link matrix.
export interface MatrixCell {
  txId: string;
  rxId: string;
  metrics: ChannelMetrics;
  paths: PropagationPath[];
}

// Ray-interaction switches + Tx/Rx antenna config, mirroring the feature
// checkboxes / antenna panel of NVIDIA's sionna-rt-gui. Sent with every
// solve (link, mobility, radio map).
export interface SolverOptions {
  los: boolean;
  specularReflection: boolean;
  diffuseReflection: boolean;
  refraction: boolean;
  diffraction: boolean;
  edgeDiffraction: boolean;
  txPattern: 'iso' | 'dipole' | 'hw_dipole' | 'tr38901';
  txPolarization: 'V' | 'H' | 'VH' | 'cross';
  rxPattern: 'iso' | 'dipole' | 'hw_dipole' | 'tr38901';
  rxPolarization: 'V' | 'H' | 'VH' | 'cross';
  pathSamplesPerSource: number;
  pathSeed: number;
}

export const DEFAULT_SOLVER_OPTIONS: SolverOptions = {
  los: true,
  specularReflection: true,
  diffuseReflection: false,
  refraction: false,
  diffraction: false,
  edgeDiffraction: false,
  txPattern: 'tr38901',
  txPolarization: 'V',
  rxPattern: 'iso',
  rxPolarization: 'V',
  pathSamplesPerSource: 1_000_000,
  pathSeed: 42,
};

export type ScatteringPattern = 'none' | 'lambertian' | 'directive' | 'backscattering';

// Per-material electromagnetic + scattering overrides, sent with each solve.
// `id` matches a building material id (e.g. 'itu_concrete').
export interface MaterialConfig {
  id: string;
  scatteringCoefficient: number; // S in [0,1]
  xpdCoefficient: number; // cross-pol discrimination in [0,1]
  scatteringPattern: ScatteringPattern;
  relativePermittivity?: number | null;
  conductivity?: number | null; // S/m
  thickness?: number | null; // m
}

export function defaultMaterialConfig(id: string): MaterialConfig {
  return { id, scatteringCoefficient: 0, xpdCoefficient: 0, scatteringPattern: 'none' };
}
