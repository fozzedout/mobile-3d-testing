import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { AudioClicker } from "../core/audio-ticks.ts";
import { VirtualJoystick } from "../core/virtual-joystick.ts";
import { CompassHUD } from "../core/compass-hud.ts";
import { orientationToQuaternion, requestMotionPermission } from "../core/device-orientation.ts";

const DEFAULT_MAX_SPEED = 60;
const DEFAULT_LOOK_RATE = 90; // deg/sec at full stick deflection

type Scheme = "dual-stick" | "gyro-move";

function buildStarfield(): THREE.Points {
  const count = 4000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = THREE.MathUtils.lerp(350, 580, Math.random());
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: true });
  return new THREE.Points(geometry, material);
}

/**
 * Free-flight 6DOF navigation lab. Two control schemes are swappable at
 * runtime so touch-navigation approaches can be compared directly:
 *  - "dual-stick": left thumb = translate (strafe + throttle, rate control),
 *    right thumb = look (yaw/pitch, rate control); a second finger landing on
 *    the look stick switches that hand to a twist-to-roll gesture.
 *  - "gyro-move": device orientation drives look (Hybrid IMU+Touch Fusion),
 *    one thumb drives translation only.
 * Both joysticks are "floating" (they spawn at the touch-down point) so
 * there's no fixed screen real estate to run out of, and lifting the finger
 * is an instant clutch. Dragging past the stick's soft limit applies a
 * logarithmic pseudo-haptic wall, paired with synthesized audio detents.
 */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = null;
  scene.background = new THREE.Color("#02030a");
  camera.far = 900;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield();
  scene.add(stars);

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2, 100);
  scene.add(shipLight);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(18, 18, 18),
    new THREE.MeshStandardMaterial({ color: "#ff9f4d", emissive: "#7a3d00", emissiveIntensity: 0.6, roughness: 0.5 }),
  );
  cube.position.set(180, 25, -70);
  scene.add(cube);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(14, 32, 24),
    new THREE.MeshStandardMaterial({ color: "#4dd2ff", emissive: "#004a5c", emissiveIntensity: 0.6, roughness: 0.4 }),
  );
  sphere.position.set(-160, -35, 130);
  scene.add(sphere);

  const shipPosition = new THREE.Vector3(0, 0, 0);
  const shipQuaternion = new THREE.Quaternion();
  const velocity = new THREE.Vector3();
  const gyroQuaternion = new THREE.Quaternion();
  let haveGyro = false;
  let pendingRoll = 0;

  camera.position.copy(shipPosition);
  camera.quaternion.copy(shipQuaternion);

  const compass = new CompassHUD(120);
  const audio = new AudioClicker();

  const params = {
    scheme: "dual-stick" as Scheme,
    maxSpeed: DEFAULT_MAX_SPEED,
    lookRate: DEFAULT_LOOK_RATE,
    audioFeedback: true,
    motionStatus: "tap Enable motion",
    speed: 0,
  };

  const moveStick = new VirtualJoystick(document.body, { color: "#8fe3a0", audio });
  const lookStick = new VirtualJoystick(document.body, { color: "#4da3ff", audio });

  function resetShip(): void {
    shipPosition.set(0, 0, 0);
    shipQuaternion.identity();
    velocity.set(0, 0, 0);
  }

  function handleOrientation(e: DeviceOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const screenAngle = THREE.MathUtils.degToRad(screen.orientation?.angle ?? 0);
    orientationToQuaternion(e.alpha, e.beta, e.gamma, screenAngle, gyroQuaternion);
    haveGyro = true;
  }

  async function enableMotion(): Promise<void> {
    const result = await requestMotionPermission();
    if (result === "unsupported") {
      params.motionStatus = "unsupported on this device";
      return;
    }
    if (result === "denied") {
      params.motionStatus = "permission denied";
      return;
    }
    window.addEventListener("deviceorientation", handleOrientation);
    params.motionStatus = "listening";
  }

  const pointers = new Map<number, { x: number; y: number }>();
  let moveTouchId: number | null = null;
  let moveOrigin = { x: 0, y: 0 };
  let lookTouchId: number | null = null;
  let lookOrigin = { x: 0, y: 0 };
  let rollTouchId: number | null = null;
  let rollPrevAngle = 0;

  function resetTouchState(): void {
    moveStick.hide();
    lookStick.hide();
    pointers.clear();
    moveTouchId = null;
    lookTouchId = null;
    rollTouchId = null;
  }

  gui.add(params, "scheme", ["dual-stick", "gyro-move"]).name("Control scheme").onChange(resetTouchState);
  gui.add({ enableMotion }, "enableMotion").name("Enable motion (gyro-move)");
  gui.add(params, "motionStatus").name("Motion status").listen().disable();
  gui.add(params, "maxSpeed", 10, 150, 5).name("Max speed");
  gui.add(params, "lookRate", 30, 180, 5).name("Look sensitivity");
  gui.add(params, "audioFeedback").name("Audio feedback").onChange((v: boolean) => {
    moveStick.audioEnabled = v;
    lookStick.audioEnabled = v;
  });
  gui.add(params, "speed").name("Speed (u/s)").listen().disable();
  gui.add({ resetShip }, "resetShip").name("Reset position");

  function onPointerDown(e: PointerEvent): void {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a reliability nicety (keeps tracking a finger that slides off
      // the canvas); if the platform refuses it, plain event delivery still works.
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (params.scheme === "gyro-move") {
      if (moveTouchId === null) {
        moveTouchId = e.pointerId;
        moveOrigin = { x: e.clientX, y: e.clientY };
        moveStick.show(e.clientX, e.clientY);
      }
      return;
    }

    const isRight = e.clientX >= window.innerWidth / 2;
    if (!isRight && moveTouchId === null) {
      moveTouchId = e.pointerId;
      moveOrigin = { x: e.clientX, y: e.clientY };
      moveStick.show(e.clientX, e.clientY);
    } else if (isRight) {
      if (lookTouchId === null) {
        lookTouchId = e.pointerId;
        lookOrigin = { x: e.clientX, y: e.clientY };
        lookStick.show(e.clientX, e.clientY);
      } else if (rollTouchId === null) {
        rollTouchId = e.pointerId;
        const a = pointers.get(lookTouchId);
        if (a) rollPrevAngle = Math.atan2(e.clientY - a.y, e.clientX - a.x);
      }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerId === moveTouchId) {
      moveStick.feed(e.clientX - moveOrigin.x, e.clientY - moveOrigin.y);
    }

    // A second finger landing on the look stick switches that hand to a
    // twist-to-roll gesture instead of feeding the look stick further.
    if (rollTouchId !== null && lookTouchId !== null) {
      const a = pointers.get(lookTouchId);
      const b = pointers.get(rollTouchId);
      if (a && b) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        let delta = angle - rollPrevAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        pendingRoll += delta;
        rollPrevAngle = angle;
      }
    } else if (e.pointerId === lookTouchId) {
      lookStick.feed(e.clientX - lookOrigin.x, e.clientY - lookOrigin.y);
    }
  }

  function releasePointer(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    if (e.pointerId === moveTouchId) {
      moveTouchId = null;
      moveStick.hide();
    }
    if (e.pointerId === lookTouchId) {
      lookTouchId = null;
      lookStick.hide();
      rollTouchId = null;
    }
    if (e.pointerId === rollTouchId) {
      rollTouchId = null;
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
  canvas.addEventListener("pointermove", onPointerMove, { passive: true });
  canvas.addEventListener("pointerup", releasePointer, { passive: true });
  canvas.addEventListener("pointercancel", releasePointer, { passive: true });

  const targets = [
    { label: "Cube", color: "#ff9f4d", position: cube.position },
    { label: "Sphere", color: "#4dd2ff", position: sphere.position },
  ];

  return {
    manualCamera: true,
    update(delta) {
      const lookRateRad = THREE.MathUtils.degToRad(params.lookRate);

      if (params.scheme === "gyro-move") {
        if (haveGyro) shipQuaternion.slerp(gyroQuaternion, Math.min(1, delta * 6));
      } else {
        const yaw = -lookStick.value.x * lookRateRad * delta;
        const pitch = -lookStick.value.y * lookRateRad * delta;
        const lookDelta = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
        shipQuaternion.multiply(lookDelta);
      }

      if (pendingRoll !== 0) {
        const rollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -pendingRoll);
        shipQuaternion.multiply(rollQuat);
        pendingRoll = 0;
      }

      const thrust = -moveStick.value.y;
      const strafe = moveStick.value.x;
      const targetVelocity = new THREE.Vector3(strafe, 0, -thrust)
        .multiplyScalar(params.maxSpeed)
        .applyQuaternion(shipQuaternion);

      velocity.lerp(targetVelocity, 1 - Math.pow(0.001, delta));
      shipPosition.addScaledVector(velocity, delta);
      params.speed = Math.round(velocity.length());

      camera.position.copy(shipPosition);
      camera.quaternion.copy(shipQuaternion);
      shipLight.position.copy(shipPosition);

      compass.update(camera, targets);
    },
    dispose() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", releasePointer);
      canvas.removeEventListener("pointercancel", releasePointer);
      window.removeEventListener("deviceorientation", handleOrientation);

      moveStick.dispose();
      lookStick.dispose();
      compass.dispose();
      audio.dispose();

      cube.geometry.dispose();
      (cube.material as THREE.Material).dispose();
      sphere.geometry.dispose();
      (sphere.material as THREE.Material).dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      scene.remove(cube, sphere, stars, shipLight, ambient);

      scene.fog = prevFog;
      scene.background = prevBackground;
      camera.far = prevCameraFar;
      camera.position.set(3, 2, 4);
      camera.quaternion.identity();
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.enabled = true;
      controls.update();
    },
  };
}

export const spaceSimScene: TestScene = {
  id: "space-sim",
  name: "Space Sim (Touch Nav)",
  description: "6DOF flight lab with a compass HUD — a testbed for touch navigation schemes.",
  setup,
};
