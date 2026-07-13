import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { ScannerHUD } from "../core/scanner-hud.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { CourseTimer } from "../core/course-timer.ts";
import { buildStarfield } from "../core/starfield.ts";
import { crossedPlane } from "../core/plane-crossing.ts";

const RING_RADIUS = 14;
const SHIP_RADIUS = 3;
const PASS_RADIUS = RING_RADIUS - SHIP_RADIUS;

// A hand-placed slalom so times are comparable run to run (a randomized
// course would make "beat your best" meaningless).
const RING_POSITIONS: THREE.Vector3Tuple[] = [
  [0, 0, -70],
  [35, 12, -150],
  [-25, -10, -230],
  [40, 20, -310],
  [-35, -15, -390],
  [20, 25, -470],
  [-30, -5, -550],
  [15, 15, -630],
  [0, 0, -710],
];

interface RingDef {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  mesh: THREE.Mesh;
}

/** Timed course: fly through every ring in order, start to finish. */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = new THREE.Fog("#02030a", 200, 950);
  scene.background = new THREE.Color("#02030a");
  camera.far = 1000;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(750, 950, 3000);
  scene.add(stars);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2, 120);
  scene.add(shipLight);

  const ringGeometry = new THREE.TorusGeometry(RING_RADIUS, 1.4, 10, 32);
  const ringDefs: RingDef[] = RING_POSITIONS.map((tuple, i) => {
    const position = new THREE.Vector3(...tuple);
    const isLast = i === RING_POSITIONS.length - 1;
    const other = isLast ? RING_POSITIONS[i - 1] : RING_POSITIONS[i + 1];
    const toOther = new THREE.Vector3(...other).sub(position).normalize();
    // For every ring but the last, `toOther` already points the way we're
    // traveling (toward the next ring). The last ring's only neighbor is
    // behind it, so flip that direction to keep the normal forward-facing.
    const normal = isLast ? toOther.clone().negate() : toOther;
    const material = new THREE.MeshStandardMaterial({
      color: "#4da3ff",
      emissive: "#0b3a66",
      emissiveIntensity: 0.5,
      roughness: 0.4,
      metalness: 0.3,
    });
    const mesh = new THREE.Mesh(ringGeometry, material);
    mesh.position.copy(position);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    scene.add(mesh);
    return { position, normal, mesh };
  });

  const rig = new FlightRig(canvas);
  rig.reset([0, 0, 0]);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const scanner = new ScannerHUD(150, 220);
  const timer = new CourseTimer({ storageKey: "course-best:ring-race" });

  let currentRing = 0;
  const prevShipPos = rig.position.clone();

  function restart(): void {
    rig.reset([0, 0, 0]);
    prevShipPos.copy(rig.position);
    currentRing = 0;
    timer.restart();
  }

  rig.registerControls(gui);
  gui.add(timer, "statusText").name("Status").listen().disable();
  gui.add(timer, "timeText").name("Time").listen().disable();
  gui.add(timer, "bestText").name("Best").listen().disable();
  gui.add({ restart }, "restart").name("Restart");

  function checkRingCrossing(): void {
    if (currentRing >= ringDefs.length) return;
    const ring = ringDefs[currentRing];
    if (!crossedPlane(prevShipPos, rig.position, ring.position, ring.normal, PASS_RADIUS)) return;

    currentRing += 1;
    if (currentRing >= ringDefs.length) {
      timer.finish();
    }
  }

  return {
    manualCamera: true,
    update(delta) {
      if (timer.state !== "countdown") rig.update(delta);
      timer.update(delta);

      if (timer.state === "racing") checkRingCrossing();
      prevShipPos.copy(rig.position);

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      const pulse = 0.6 + Math.sin(performance.now() / 200) * 0.4;
      ringDefs.forEach((ring, i) => {
        const mat = ring.mesh.material as THREE.MeshStandardMaterial;
        const isTarget = i === currentRing;
        mat.emissiveIntensity = isTarget ? 0.6 + pulse : 0.15;
        mat.color.set(isTarget ? "#ffd24d" : i < currentRing ? "#2f4d3a" : "#4da3ff");
      });

      if (currentRing < ringDefs.length) {
        const next = ringDefs[currentRing];
        scanner.update(rig.position, rig.quaternion, [
          { label: `Ring ${currentRing + 1}/${ringDefs.length}`, color: "#ffd24d", position: next.position },
        ]);
      }
    },
    dispose() {
      rig.dispose();
      scanner.dispose();

      ringGeometry.dispose();
      ringDefs.forEach((ring) => {
        (ring.mesh.material as THREE.Material).dispose();
        scene.remove(ring.mesh);
      });
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      scene.remove(stars, ambient, shipLight);

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

export const ringRaceScene: TestScene = {
  id: "ring-race",
  name: "Course: Ring Race",
  description: "Timed run: fly through every ring in order, start to finish.",
  setup,
};
