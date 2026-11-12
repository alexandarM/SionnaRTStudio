/**
 * Universal source-scene coordinate frame adapter.
 *
 * Canonical application/Sionna frame: right-handed, +Z up, +X forward, metres.
 * Source axes and units are explicit; no indoor axis is assumed by default
 * beyond the canonical frame used for Sionna RT.
 */
export type SignedAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
export type SceneUnits = 'm' | 'cm' | 'mm' | 'ft' | 'in' | 'custom';
export type SceneHandedness = 'right' | 'left';
export type Vector3 = readonly [number, number, number];
export type Matrix3 = readonly [Vector3, Vector3, Vector3];

export interface SceneCoordinateFrame {
  upAxis: SignedAxis;
  forwardAxis: SignedAxis;
  units: SceneUnits;
  handedness: SceneHandedness;
  /** Required and positive only when units is `custom`; metres per source unit. */
  customScaleToMeters?: number | null;
  /** Source-space coordinates that become canonical origin, in source units. */
  origin: Vector3;
}

export interface SceneBounds {
  minimum: Vector3;
  maximum: Vector3;
}

export interface SceneCoordinateTransform {
  frame: SceneCoordinateFrame;
  matrix: Matrix3;
  inverseMatrix: Matrix3;
  scaleToMeters: number;
  determinant: number;
  requiresWindingFlip: boolean;
}

export const CANONICAL_SCENE_FRAME = Object.freeze({
  upAxis: '+Z' as const,
  forwardAxis: '+X' as const,
  units: 'm' as const,
  handedness: 'right' as const,
});

const UNIT_TO_METERS: Record<SceneUnits, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  in: 0.0254,
  custom: Number.NaN,
};

const finite3 = (v: Vector3): boolean =>
  v.length === 3 && v.every(Number.isFinite);

export function signedAxisVector(axis: SignedAxis): Vector3 {
  const sign = axis[0] === '+' ? 1 : -1;
  switch (axis[1]) {
    case 'X': return [sign, 0, 0];
    case 'Y': return [0, sign, 0];
    case 'Z': return [0, 0, sign];
    default: throw new Error(`Invalid signed axis: ${axis}`);
  }
}

const dot = (a: Vector3, b: Vector3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vector3, b: Vector3): Vector3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const determinant = (m: Matrix3): number =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
  - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
  + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

const transpose = (m: Matrix3): Matrix3 => [
  [m[0][0], m[1][0], m[2][0]],
  [m[0][1], m[1][1], m[2][1]],
  [m[0][2], m[1][2], m[2][2]],
];

const matVec = (m: Matrix3, v: Vector3): Vector3 => [
  dot(m[0], v), dot(m[1], v), dot(m[2], v),
];

const matMul = (a: Matrix3, b: Matrix3): Matrix3 => {
  const bt = transpose(b);
  return [
    [dot(a[0], bt[0]), dot(a[0], bt[1]), dot(a[0], bt[2])],
    [dot(a[1], bt[0]), dot(a[1], bt[1]), dot(a[1], bt[2])],
    [dot(a[2], bt[0]), dot(a[2], bt[1]), dot(a[2], bt[2])],
  ];
};

export function createSceneCoordinateTransform(
  frame: SceneCoordinateFrame,
): SceneCoordinateTransform {
  if (!finite3(frame.origin)) throw new Error('Scene origin must contain three finite values');
  const up = signedAxisVector(frame.upAxis);
  const forward = signedAxisVector(frame.forwardAxis);
  if (Math.abs(dot(up, forward)) > 1e-9) {
    throw new Error('upAxis and forwardAxis must be perpendicular signed axes');
  }
  if (frame.units === 'custom') {
    if (frame.customScaleToMeters == null || !Number.isFinite(frame.customScaleToMeters)
        || frame.customScaleToMeters <= 0) {
      throw new Error('customScaleToMeters must be positive and finite for custom units');
    }
  } else if (frame.customScaleToMeters != null) {
    throw new Error('customScaleToMeters is only valid with custom units');
  }
  let lateral = cross(up, forward);
  if (frame.handedness === 'left') lateral = lateral.map(v => -v) as unknown as Vector3;
  const matrix: Matrix3 = [forward, lateral, up];
  const det = determinant(matrix);
  return {
    frame,
    matrix,
    inverseMatrix: transpose(matrix),
    scaleToMeters: frame.units === 'custom'
      ? Number(frame.customScaleToMeters)
      : UNIT_TO_METERS[frame.units],
    determinant: det,
    requiresWindingFlip: det < 0,
  };
}

export function sourcePointToCanonical(
  point: Vector3,
  transform: SceneCoordinateTransform,
): Vector3 {
  if (!finite3(point)) throw new Error('Point must contain three finite coordinates');
  const origin = transform.frame.origin;
  const relative: Vector3 = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const mapped = matVec(transform.matrix, relative);
  return mapped.map(v => v * transform.scaleToMeters) as unknown as Vector3;
}

export function canonicalPointToSource(
  point: Vector3,
  transform: SceneCoordinateTransform,
): Vector3 {
  if (!finite3(point)) throw new Error('Point must contain three finite coordinates');
  const scaled = point.map(v => v / transform.scaleToMeters) as unknown as Vector3;
  const relative = matVec(transform.inverseMatrix, scaled);
  return relative.map((v, i) => v + transform.frame.origin[i]) as unknown as Vector3;
}

export function sourceVectorToCanonical(
  vector: Vector3,
  transform: SceneCoordinateTransform,
  scaleUnits = false,
): Vector3 {
  if (!finite3(vector)) throw new Error('Vector must contain three finite coordinates');
  const mapped = matVec(transform.matrix, vector);
  const scale = scaleUnits ? transform.scaleToMeters : 1;
  return mapped.map(v => v * scale) as unknown as Vector3;
}

export function sourceNormalToCanonical(
  normal: Vector3,
  transform: SceneCoordinateTransform,
): Vector3 {
  const mapped = sourceVectorToCanonical(normal, transform);
  const length = Math.hypot(...mapped);
  if (length <= 1e-15) throw new Error('Cannot normalize a zero-length normal');
  return mapped.map(v => v / length) as unknown as Vector3;
}

export function sourceBoundsToCanonical(
  bounds: SceneBounds,
  transform: SceneCoordinateTransform,
): SceneBounds {
  if (!finite3(bounds.minimum) || !finite3(bounds.maximum)
      || bounds.minimum.some((v, i) => v > bounds.maximum[i])) {
    throw new Error('Invalid scene bounds');
  }
  const corners: Vector3[] = [];
  for (const x of [bounds.minimum[0], bounds.maximum[0]]) {
    for (const y of [bounds.minimum[1], bounds.maximum[1]]) {
      for (const z of [bounds.minimum[2], bounds.maximum[2]]) corners.push([x, y, z]);
    }
  }
  const mapped = corners.map(point => sourcePointToCanonical(point, transform));
  return {
    minimum: [0, 1, 2].map(i => Math.min(...mapped.map(p => p[i]))) as unknown as Vector3,
    maximum: [0, 1, 2].map(i => Math.max(...mapped.map(p => p[i]))) as unknown as Vector3,
  };
}

export function sourceRotationToCanonical(
  rotation: Matrix3,
  transform: SceneCoordinateTransform,
): Matrix3 {
  if (rotation.some(row => row.some(value => !Number.isFinite(value)))) {
    throw new Error('Rotation must contain finite values');
  }
  const qtq = matMul(transpose(rotation), rotation);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const expected = r === c ? 1 : 0;
      if (Math.abs(qtq[r][c] - expected) > 1e-6) throw new Error('Rotation must be orthonormal');
    }
  }
  if (Math.abs(determinant(rotation) - 1) > 1e-6) {
    throw new Error('Rotation must be a proper rotation (determinant +1)');
  }
  return matMul(matMul(transform.matrix, rotation), transform.inverseMatrix);
}
