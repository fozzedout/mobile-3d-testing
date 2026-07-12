import * as THREE from "three";

interface OrientationCapableEvent {
  requestPermission?: () => Promise<"granted" | "denied">;
}

export type MotionPermission = "granted" | "denied" | "unsupported";

/** iOS 13+ gates deviceorientation behind a user-gesture permission prompt; other platforms don't need it. */
export async function requestMotionPermission(): Promise<MotionPermission> {
  if (typeof DeviceOrientationEvent === "undefined") return "unsupported";
  const DOE = DeviceOrientationEvent as unknown as OrientationCapableEvent;
  if (typeof DOE.requestPermission !== "function") return "granted";
  try {
    return await DOE.requestPermission();
  } catch {
    return "unsupported";
  }
}

const eulerScratch = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const zee = new THREE.Vector3(0, 0, 1);

/** Reproduces the standard device-orientation -> world quaternion mapping (screen-orientation aware). */
export function orientationToQuaternion(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
  target: THREE.Quaternion,
): THREE.Quaternion {
  eulerScratch.set(
    THREE.MathUtils.degToRad(beta),
    THREE.MathUtils.degToRad(alpha),
    THREE.MathUtils.degToRad(-gamma),
    "YXZ",
  );
  target.setFromEuler(eulerScratch);
  target.multiply(q1);
  target.multiply(q0.setFromAxisAngle(zee, -screenAngle));
  return target;
}
