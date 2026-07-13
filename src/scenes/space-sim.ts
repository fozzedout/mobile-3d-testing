import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { AudioClicker } from "../core/audio-ticks.ts";
import { VirtualJoystick } from "../core/virtual-joystick.ts";
import { CompassHUD } from "../core/compass-hud.ts";
import { orientationToQuaternion, requestMotionPermission } from "../core/device-orientation.ts";

const DEFAULT_MAX_SPEED = 60;
const DEFAULT_LOOK_RATE = 90; // deg/sec at full stick deflection

// Time-based rate/position hybrid: a look-stick touch shorter than this
// (in time AND distance) is treated as a precise position-control flick;
// crossing either threshold promotes it to ongoing rate control.
const FLICK_TIME_MS = 220;
const FLICK_DIST_PX = 38;
const FLICK_MAX_ANGLE = THREE.MathUtils.degToRad(10);

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
  const angularVelocity = { yaw: 0, pitch: 0 }; // rad/sec, local frame — used when rotationalInertia is on
  const gyroQuaternion = new THREE.Quaternion();
  let haveGyro = false;
  let gyroTrimPrev: THREE.Quaternion | null = null;
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
    gyroTrim: false,
    gyroTrimStrength: 0.25,
    precisionFlick: true,
    rotationalInertia: false,
    inertiaRampMs: 120,
    inertiaBrakeMs: 90,
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
  let lastLookDx = 0;
  let lastLookDy = 0;
  let lookTouchStartTime = 0;
  let lookMode: "position" | "rate" = "rate";
  const lookBaseQuaternion = new THREE.Quaternion();
  let rollTouchId: number | null = null;
  let rollPrevAngle = 0;

  function resetTouchState(): void {
    moveStick.hide();
    lookStick.hide();
    pointers.clear();
    moveTouchId = null;
    lookTouchId = null;
    rollTouchId = null;
    gyroTrimPrev = null;
  }

  gui.add(params, "scheme", ["dual-stick", "gyro-move"]).name("Control scheme").onChange(resetTouchState);
  gui.add({ enableMotion }, "enableMotion").name("Enable motion");
  gui.add(params, "motionStatus").name("Motion status").listen().disable();
  gui.add(params, "gyroTrim").name("Gyro fine-trim (dual-stick)");
  gui.add(params, "gyroTrimStrength", 0.05, 0.6, 0.05).name("Gyro trim strength");
  gui.add(params, "precisionFlick").name("Precision flick mode");
  gui.add(params, "rotationalInertia").name("Rotational inertia");
  gui.add(params, "inertiaRampMs", 30, 400, 10).name("Inertia ramp-in (ms)");
  gui.add(params, "inertiaBrakeMs", 30, 400, 10).name("Inertia brake (ms)");
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
        lastLookDx = 0;
        lastLookDy = 0;
        lookTouchStartTime = performance.now();
        lookMode = "position";
        lookBaseQuaternion.copy(shipQuaternion);
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
      lastLookDx = e.clientX - lookOrigin.x;
      lastLookDy = e.clientY - lookOrigin.y;
      lookStick.feed(lastLookDx, lastLookDy);
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
        angularVelocity.yaw = 0;
        angularVelocity.pitch = 0;
      } else {
        // Time-based rate/position hybrid: a fresh look-stick touch starts in
        // "position" mode (finger offset maps directly to a small, precise
        // absolute look angle, no momentum) and promotes to ongoing rate
        // control once it's held past a time or distance threshold.
        let handledByFlick = false;
        if (params.precisionFlick && lookTouchId !== null) {
          if (lookMode === "position") {
            const held = performance.now() - lookTouchStartTime;
            const dist = Math.hypot(lastLookDx, lastLookDy);
            if (held < FLICK_TIME_MS && dist < FLICK_DIST_PX) {
              const posYaw = -THREE.MathUtils.clamp(lastLookDx / FLICK_DIST_PX, -1, 1) * FLICK_MAX_ANGLE;
              const posPitch = -THREE.MathUtils.clamp(lastLookDy / FLICK_DIST_PX, -1, 1) * FLICK_MAX_ANGLE;
              const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(posPitch, posYaw, 0, "YXZ"));
              shipQuaternion.copy(lookBaseQuaternion).multiply(offset);
              angularVelocity.yaw = 0;
              angularVelocity.pitch = 0;
              handledByFlick = true;
            } else {
              lookMode = "rate"; // promoted — falls through to rate control below, continuing from here
            }
          }
        }

        if (!handledByFlick) {
          const targetYawRate = -lookStick.value.x * lookRateRad;
          const targetPitchRate = -lookStick.value.y * lookRateRad;

          if (params.rotationalInertia) {
            const stickActive = Math.hypot(lookStick.value.x, lookStick.value.y) > 0.02;
            // Tunable smoothing while steering vs. decay the instant the stick
            // is released — kept as separate sliders since "let go" should
            // stay a fairly trustworthy stop signal even at gentler settings.
            const timeConstant = (stickActive ? params.inertiaRampMs : params.inertiaBrakeMs) / 1000;
            const factor = 1 - Math.exp(-delta / timeConstant);
            angularVelocity.yaw = THREE.MathUtils.lerp(angularVelocity.yaw, targetYawRate, factor);
            angularVelocity.pitch = THREE.MathUtils.lerp(angularVelocity.pitch, targetPitchRate, factor);
          } else {
            angularVelocity.yaw = targetYawRate;
            angularVelocity.pitch = targetPitchRate;
          }

          const lookDelta = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(angularVelocity.pitch * delta, angularVelocity.yaw * delta, 0, "YXZ"),
          );
          shipQuaternion.multiply(lookDelta);
        }

        // Gyro fine-trim: adds the device's relative tilt since last frame as a
        // small additive nudge on top of stick-driven look, rather than
        // replacing it outright (avoids the "absolute mapping" finickiness of
        // the gyro-move scheme while still giving fine-aim assistance).
        if (params.gyroTrim && haveGyro) {
          if (gyroTrimPrev) {
            const trimDelta = gyroTrimPrev.clone().invert().multiply(gyroQuaternion);
            const scaled = new THREE.Quaternion().identity().slerp(trimDelta, params.gyroTrimStrength);
            shipQuaternion.multiply(scaled);
          }
          gyroTrimPrev = gyroQuaternion.clone();
        } else {
          gyroTrimPrev = null;
        }
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

      compass.update(camera, targets, delta);
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
