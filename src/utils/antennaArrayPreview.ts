import * as THREE from 'three';
import type { SceneLocalQuaternion, SceneLocalVector3 } from '../types';

export interface PlanarArrayPreview {
  columns: number;
  rows: number;
  elementCount: number;
  polarizationPorts: number;
  wavelengthMeters: number;
  spacingMeters: number;
  horizontalApertureMeters: number;
  verticalApertureMeters: number;
  /** Element centres in the device-local canonical XY plane (metres). */
  elementOffsetsCanonical: SceneLocalVector3[];
}

const C_M_PER_S = 299_792_458;
const MAX_VISUAL_ELEMENTS = 4096;

export function getWavelengthMeters(frequencyGhz: number): number {
  if (!Number.isFinite(frequencyGhz) || frequencyGhz <= 0) {
    throw new RangeError('Carrier frequency must be a positive finite value in GHz.');
  }
  return C_M_PER_S / (frequencyGhz * 1e9);
}

/** Visual glyph dimensions scale with the configured physical element pitch. */
export function getArrayElementVisualDimensions(spacingMeters: number): { radiusMeters: number; thicknessMeters: number } {
  if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
    throw new RangeError('Element spacing must be a positive finite value in metres.');
  }
  return {
    radiusMeters: Math.max(0.0001, Math.min(0.012, spacingMeters * 0.18)),
    thicknessMeters: Math.max(0.0001, Math.min(0.004, spacingMeters * 0.08)),
  };
}

/**
 * Build the same centered 0.5-lambda planar grid used by the current Sionna
 * PlanarArray configuration. The UI convention is [horizontal columns, vertical rows].
 * This is a visual/configuration helper; Sionna remains the RF authority.
 */
export function buildPlanarArrayPreview(
  arraySize: readonly number[],
  frequencyGhz: number,
  polarization: string,
  spacingLambda = 0.5,
): PlanarArrayPreview {
  const columns = Math.trunc(Number(arraySize[0]));
  const rows = Math.trunc(Number(arraySize[1]));
  if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns < 1 || rows < 1 || columns > 64 || rows > 64) {
    throw new RangeError('PlanarArray dimensions must be integers in the range 1…64.');
  }
  const count = columns * rows;
  if (count > MAX_VISUAL_ELEMENTS) throw new RangeError(`Array preview exceeds ${MAX_VISUAL_ELEMENTS} elements.`);
  if (!Number.isFinite(spacingLambda) || spacingLambda <= 0) throw new RangeError('Element spacing must be positive.');
  const wavelengthMeters = getWavelengthMeters(frequencyGhz);
  const spacingMeters = spacingLambda * wavelengthMeters;
  const elementOffsetsCanonical: SceneLocalVector3[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = (column - (columns - 1) / 2) * spacingMeters;
      const y = ((rows - 1) / 2 - row) * spacingMeters;
      elementOffsetsCanonical.push([x, y, 0]);
    }
  }
  const dual = polarization === 'VH' || polarization === 'cross';
  return {
    columns,
    rows,
    elementCount: count,
    polarizationPorts: count * (dual ? 2 : 1),
    wavelengthMeters,
    spacingMeters,
    horizontalApertureMeters: (columns - 1) * spacingMeters,
    verticalApertureMeters: (rows - 1) * spacingMeters,
    elementOffsetsCanonical,
  };
}

/**
 * Indoor steering convention: local +Z is the mounted antenna boresight.
 * Azimuth rotates toward local +X; elevation tilts toward local +Y.
 * Both angles are device-local offsets, not geographic bearings.
 */
export function localSteeringDirectionCanonical(
  azimuthDeg: number,
  elevationDeg: number,
): SceneLocalVector3 {
  const az = THREE.MathUtils.degToRad(Number(azimuthDeg) || 0);
  const el = THREE.MathUtils.degToRad(Number(elevationDeg) || 0);
  const direction = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ).normalize();
  return [direction.x, direction.y, direction.z];
}

export function rotateLocalDirectionToCanonicalWorld(
  localDirection: SceneLocalVector3,
  orientation?: SceneLocalQuaternion,
): SceneLocalVector3 {
  const q = orientation
    ? new THREE.Quaternion(orientation[0], orientation[1], orientation[2], orientation[3]).normalize()
    : new THREE.Quaternion();
  const d = new THREE.Vector3(...localDirection).applyQuaternion(q).normalize();
  return [d.x, d.y, d.z];
}

/** Canonical +Z-up vector mapped into ThreeStudio's existing Y-up viewport frame. */
export function canonicalDirectionToThree(direction: SceneLocalVector3): THREE.Vector3 {
  return new THREE.Vector3(direction[0], direction[2], -direction[1]).normalize();
}

/** Canonical local array-plane offset mapped into a ThreeStudio device-root local frame. */
export function canonicalArrayOffsetToThree(offset: SceneLocalVector3): THREE.Vector3 {
  return new THREE.Vector3(offset[0], offset[2], -offset[1]);
}
