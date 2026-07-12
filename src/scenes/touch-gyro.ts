import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";

interface OrientationCapableEvent {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/** Reproduces the standard device-orientation → world quaternion mapping (screen-orientation aware). */
function orientationToQuaternion(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
  target: THREE.Quaternion,
): THREE.Quaternion {
  const euler = new THREE.Euler();
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  const zee = new THREE.Vector3(0, 0, 1);

  euler.set(THREE.MathUtils.degToRad(beta), THREE.MathUtils.degToRad(alpha), THREE.MathUtils.degToRad(-gamma), "YXZ");
  target.setFromEuler(euler);
  target.multiply(q1);
  target.multiply(q0.setFromAxisAngle(zee, -screenAngle));
  return target;
}

function setup({ scene, gui, canvas }: SceneContext): SceneInstance {
  const readout = { alpha: 0, beta: 0, gamma: 0, motion: "tap Enable motion" };

  const phone = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.8, 0.12),
    new THREE.MeshStandardMaterial({ color: "#2a2f3a", roughness: 0.5, metalness: 0.2 }),
  );
  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.72, 1.5),
    new THREE.MeshStandardMaterial({ color: "#4da3ff", emissive: "#0b3a66", emissiveIntensity: 0.6 }),
  );
  screenMesh.position.z = 0.062;
  phone.add(body, screenMesh);
  scene.add(phone);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const light = new THREE.DirectionalLight(0xffffff, 1.4);
  light.position.set(2, 3, 4);
  scene.add(light);

  const quaternion = new THREE.Quaternion();
  let haveOrientation = false;

  function handleOrientation(e: DeviceOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    readout.alpha = Math.round(e.alpha);
    readout.beta = Math.round(e.beta);
    readout.gamma = Math.round(e.gamma);
    const screenAngle = THREE.MathUtils.degToRad((screen.orientation?.angle ?? 0));
    orientationToQuaternion(e.alpha, e.beta, e.gamma, screenAngle, quaternion);
    haveOrientation = true;
  }

  async function enableMotion(): Promise<void> {
    const DOE = DeviceOrientationEvent as unknown as OrientationCapableEvent;
    try {
      if (typeof DOE.requestPermission === "function") {
        const result = await DOE.requestPermission();
        if (result !== "granted") {
          readout.motion = "permission denied";
          return;
        }
      }
      window.addEventListener("deviceorientation", handleOrientation);
      readout.motion = "listening";
    } catch {
      readout.motion = "unsupported on this device";
    }
  }

  gui.add({ enableMotion }, "enableMotion").name("Enable motion");
  gui.add(readout, "motion").name("Status").listen().disable();
  gui.add(readout, "alpha", -180, 180).listen().disable();
  gui.add(readout, "beta", -180, 180).listen().disable();
  gui.add(readout, "gamma", -180, 180).listen().disable();

  // Live touch-point visualizer, independent of OrbitControls, to sanity-check multi-touch input.
  const dots = new Map<number, HTMLDivElement>();
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:15;";
  document.body.appendChild(overlay);

  function moveDot(e: PointerEvent): void {
    let dot = dots.get(e.pointerId);
    if (!dot) {
      dot = document.createElement("div");
      dot.className = "touch-dot";
      overlay.appendChild(dot);
      dots.set(e.pointerId, dot);
    }
    dot.style.left = `${e.clientX}px`;
    dot.style.top = `${e.clientY}px`;
  }
  function removeDot(e: PointerEvent): void {
    dots.get(e.pointerId)?.remove();
    dots.delete(e.pointerId);
  }

  canvas.addEventListener("pointerdown", moveDot, { passive: true });
  canvas.addEventListener("pointermove", moveDot, { passive: true });
  canvas.addEventListener("pointerup", removeDot, { passive: true });
  canvas.addEventListener("pointercancel", removeDot, { passive: true });

  return {
    update() {
      if (haveOrientation) phone.quaternion.slerp(quaternion, 0.25);
    },
    dispose() {
      window.removeEventListener("deviceorientation", handleOrientation);
      canvas.removeEventListener("pointerdown", moveDot);
      canvas.removeEventListener("pointermove", moveDot);
      canvas.removeEventListener("pointerup", removeDot);
      canvas.removeEventListener("pointercancel", removeDot);
      overlay.remove();
      body.geometry.dispose();
      (body.material as THREE.Material).dispose();
      screenMesh.geometry.dispose();
      (screenMesh.material as THREE.Material).dispose();
      scene.remove(phone, light);
    },
  };
}

export const touchGyroScene: TestScene = {
  id: "touch-gyro",
  name: "Touch & Gyro",
  description: "Visualizes raw multi-touch points and device-orientation sensor data.",
  setup,
};
