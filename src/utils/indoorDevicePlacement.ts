import * as THREE from 'three';

export type SceneVector3 = [number, number, number];
export type SceneQuaternion = [number, number, number, number];
export type IndoorSurfaceKind = 'floor' | 'ceiling' | 'wall' | 'other';

/**
 * The imported Mitsuba preview is already expressed in canonical Sionna
 * coordinates (right-handed, metres, +Z up). ThreeStudio's existing world is
 * Y-up, so these helpers only adapt between the two render coordinate frames.
 * They do not alter the stored canonical scene coordinates.
 */
export function canonicalToThreePosition(value: SceneVector3): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[2], -value[1]);
}

export function threeToCanonicalPosition(value: THREE.Vector3): SceneVector3 {
  return [value.x, -value.z, value.y];
}

export function threeDirectionToCanonical(value: THREE.Vector3): SceneVector3 {
  const direction = value.clone().normalize();
  return [direction.x, -direction.z, direction.y];
}

export function classifyIndoorSurface(normalThree: THREE.Vector3, threshold = 0.65): IndoorSurfaceKind {
  const n = normalThree.clone().normalize();
  if (n.y >= threshold) return 'floor';
  if (n.y <= -threshold) return 'ceiling';
  // Near-vertical surfaces have a small up component. Sloped ramps and other
  // oblique surfaces remain 'other' instead of being mislabeled as walls.
  if (Math.abs(n.y) <= (1 - threshold)) return 'wall';
  return 'other';
}

/**
 * Aligns a device's local +Y axis with a hit surface normal in Three.js world
 * space, then expresses that orientation in the canonical scene frame.
 */
export function surfaceNormalToCanonicalQuaternion(normalThree: THREE.Vector3): SceneQuaternion {
  const upThree = new THREE.Vector3(0, 1, 0);
  const orientationThree = new THREE.Quaternion().setFromUnitVectors(upThree, normalThree.clone().normalize());
  return threeQuaternionToCanonical(orientationThree);
}

/** Convert a Three.js world-space device rotation to canonical scene rotation. */
export function threeQuaternionToCanonical(value: THREE.Quaternion): SceneQuaternion {
  // Canonical -> Three is a -90 degree X rotation: (x,y,z) -> (x,z,-y).
  const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const canonical = basis.clone().invert().multiply(value.clone()).multiply(basis).normalize();
  return [canonical.x, canonical.y, canonical.z, canonical.w];
}

/** Convert a stored canonical scene rotation to Three.js world-space rotation. */
export function canonicalQuaternionToThree(value?: SceneQuaternion): THREE.Quaternion {
  if (!value) return new THREE.Quaternion();
  const canonical = new THREE.Quaternion(value[0], value[1], value[2], value[3]).normalize();
  const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  return basis.clone().multiply(canonical).multiply(basis.clone().invert()).normalize();
}

export function offsetCanonicalPosition(
  hitPointThree: THREE.Vector3,
  hitNormalThree: THREE.Vector3,
  offsetMeters = 0.045,
): SceneVector3 {
  const offsetPoint = hitPointThree.clone().add(hitNormalThree.clone().normalize().multiplyScalar(offsetMeters));
  return threeToCanonicalPosition(offsetPoint);
}
