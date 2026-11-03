/**
 * City-scale preview streaming and level-of-detail policy.
 * These helpers only control disposable Three.js preview geometry; they never
 * modify BuildingFootprint input data or any Sionna RT simulation parameters.
 */
export const PREVIEW_LOD_CONFIG = {
  chunkMetersDefault: 250,
  chunkMetersLargeScene: 500,
  largeSceneFeatureThreshold: 10_000,
  coarseToleranceSmallSceneMeters: 1.25,
  coarseToleranceLargeSceneMeters: 2.0,
  coarseToleranceFeatureThreshold: 5_000,
  mediumToleranceMeters: 0.55,
  highDetailEnterMeters: 480,
  highDetailExitMeters: 720,
  mediumDetailEnterMeters: 1_550,
  mediumDetailExitMeters: 1_950,
  maxRefinedChunks: 18,
  featureBatchSize: 64,
  // The viewer starts well outside the city footprint; the load radius must
  // cover the full initial camera-to-far-corner distance for city overviews.
  loadRadiusScale: 1.35,
  minLoadRadiusMeters: 1_000,
  maxLoadRadiusMeters: 400_000,
  unloadRadiusScale: 1.75,
  featureBoundsLoadFactor: 0.5,
  nearChunkLoadFactor: 2.2,
  coarseChunkSphereFactor: 0.95,
} as const;

export function getPreviewChunkMeters(featureCount: number): number {
  return featureCount >= PREVIEW_LOD_CONFIG.largeSceneFeatureThreshold
    ? PREVIEW_LOD_CONFIG.chunkMetersLargeScene
    : PREVIEW_LOD_CONFIG.chunkMetersDefault;
}

export function getPreviewCoarseTolerance(featureCount: number): number {
  return featureCount >= PREVIEW_LOD_CONFIG.coarseToleranceFeatureThreshold
    ? PREVIEW_LOD_CONFIG.coarseToleranceLargeSceneMeters
    : PREVIEW_LOD_CONFIG.coarseToleranceSmallSceneMeters;
}

/** Base preview simplification used when a chunk first becomes resident.
 * Full-detail mode returns zero tolerance; it never changes source OSM data.
 */
export function getPreviewBaseTolerance(lodEnabled: boolean, featureCount: number): number {
  return lodEnabled ? getPreviewCoarseTolerance(featureCount) : 0;
}

/** Return null for coarse LOD, 0 for full-detail preview, or a simplification
 * tolerance in metres for medium LOD. Hysteresis avoids repeated mesh rebuilds
 * while the camera moves around LOD boundaries. */
export function getDesiredPreviewTolerance(
  distanceMeters: number,
  currentTolerance: number | null = null,
): number | null {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return null;

  if (currentTolerance === 0) {
    if (distanceMeters <= PREVIEW_LOD_CONFIG.highDetailExitMeters) return 0;
    if (distanceMeters <= PREVIEW_LOD_CONFIG.mediumDetailExitMeters) return PREVIEW_LOD_CONFIG.mediumToleranceMeters;
    return null;
  }
  if (currentTolerance !== null) {
    if (distanceMeters <= PREVIEW_LOD_CONFIG.highDetailEnterMeters) return 0;
    if (distanceMeters <= PREVIEW_LOD_CONFIG.mediumDetailExitMeters) return PREVIEW_LOD_CONFIG.mediumToleranceMeters;
    return null;
  }
  if (distanceMeters <= PREVIEW_LOD_CONFIG.highDetailEnterMeters) return 0;
  if (distanceMeters <= PREVIEW_LOD_CONFIG.mediumDetailEnterMeters) return PREVIEW_LOD_CONFIG.mediumToleranceMeters;
  return null;
}

export function getPreviewLoadRadius(cameraDistanceMeters: number): number {
  const distance = Number.isFinite(cameraDistanceMeters) ? Math.max(0, cameraDistanceMeters) : 0;
  return Math.min(
    PREVIEW_LOD_CONFIG.maxLoadRadiusMeters,
    Math.max(PREVIEW_LOD_CONFIG.minLoadRadiusMeters, distance * PREVIEW_LOD_CONFIG.loadRadiusScale),
  );
}

export function getPreviewUnloadRadius(loadRadiusMeters: number): number {
  return Math.max(0, loadRadiusMeters) * PREVIEW_LOD_CONFIG.unloadRadiusScale;
}

export function shouldStreamPreviewChunk(
  distanceMeters: number,
  loadRadiusMeters: number,
  boundsRadiusMeters: number,
  intersectsFrustum: boolean,
  chunkMeters: number,
): boolean {
  const featureMargin = Math.max(0, boundsRadiusMeters) * PREVIEW_LOD_CONFIG.featureBoundsLoadFactor;
  const nearMargin = chunkMeters * PREVIEW_LOD_CONFIG.nearChunkLoadFactor + featureMargin;
  return distanceMeters <= loadRadiusMeters + featureMargin &&
    (intersectsFrustum || distanceMeters < nearMargin);
}

export function shouldUnloadPreviewChunk(
  distanceMeters: number,
  unloadRadiusMeters: number,
  boundsRadiusMeters: number,
  intersectsFrustum: boolean,
): boolean {
  const featureMargin = Math.max(0, boundsRadiusMeters) * PREVIEW_LOD_CONFIG.featureBoundsLoadFactor;
  return distanceMeters > unloadRadiusMeters + featureMargin && !intersectsFrustum;
}
