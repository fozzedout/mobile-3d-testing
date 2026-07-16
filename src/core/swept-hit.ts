import * as THREE from "three";

// Shared scratch — safe because JS is single-threaded and these never escape.
const seg = new THREE.Vector3();
const toCenter = new THREE.Vector3();
const closest = new THREE.Vector3();

/**
 * Whether the segment from `from` to `to` passes within `radius` of `center`.
 *
 * Projectile hit tests must be swept, not point-sampled: a laser moving
 * 220 u/s covers ~7.3 units per frame at 30fps — more than the smaller hit
 * radii in the arenas — so testing only the endpoint can tunnel straight
 * through a target on a slow (mobile) frame. Testing the whole segment the
 * projectile traveled this frame closes that gap for any frame rate.
 */
export function segmentHitsSphere(from: THREE.Vector3, to: THREE.Vector3, center: THREE.Vector3, radius: number): boolean {
  seg.subVectors(to, from);
  const lengthSq = seg.lengthSq();
  if (lengthSq < 1e-12) return from.distanceToSquared(center) <= radius * radius;
  toCenter.subVectors(center, from);
  const t = THREE.MathUtils.clamp(toCenter.dot(seg) / lengthSq, 0, 1);
  closest.copy(from).addScaledVector(seg, t);
  return closest.distanceToSquared(center) <= radius * radius;
}
