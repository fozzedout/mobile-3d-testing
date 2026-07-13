import * as THREE from "three";

/**
 * True if the segment from prevPos to currPos crosses the plane through
 * planePosition (normal planeNormal) within `radius` of that point — i.e.
 * "flew through the ring/gate", not just crossed its infinite plane.
 */
export function crossedPlane(
  prevPos: THREE.Vector3,
  currPos: THREE.Vector3,
  planePosition: THREE.Vector3,
  planeNormal: THREE.Vector3,
  radius: number,
): boolean {
  const dPrev = prevPos.clone().sub(planePosition).dot(planeNormal);
  const dCurr = currPos.clone().sub(planePosition).dot(planeNormal);
  if ((dPrev < 0) === (dCurr < 0)) return false; // didn't cross the plane this frame

  const t = dPrev / (dPrev - dCurr);
  const crossPoint = prevPos.clone().lerp(currPos, t);
  return crossPoint.sub(planePosition).length() <= radius;
}
