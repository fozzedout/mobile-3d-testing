import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { CompassHUD } from "../core/compass-hud.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { CourseTimer } from "../core/course-timer.ts";
import { HitFlash } from "../core/hit-flash.ts";
import { buildStarfield } from "../core/starfield.ts";

const TUNNEL_RADIUS = 20;
const SHIP_RADIUS = 3;
const FINISH_RADIUS = 22;
const HIT_PENALTY_MS = 2000;
const INVULN_SECONDS = 0.8;

// Deterministic waypoints (fair to compare best times against) for a winding tunnel.
const WAYPOINTS: THREE.Vector3Tuple[] = [
  [0, 0, 0],
  [10, 5, -60],
  [-15, 15, -130],
  [20, -10, -200],
  [40, 0, -280],
  [10, -20, -360],
  [-30, 10, -430],
  [-10, -15, -500],
  [30, 20, -570],
  [0, 0, -650],
];

interface Obstacle {
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  halfSize: THREE.Vector3;
}

const OBSTACLE_DEFS: { position: THREE.Vector3Tuple; size: THREE.Vector3Tuple }[] = [
  { position: [8, 8, -95], size: [14, 3, 3] },
  { position: [-8, -5, -240], size: [3, 14, 3] },
  { position: [15, -3, -320], size: [3, 3, 18] },
  { position: [-5, 10, -460], size: [16, 3, 3] },
  { position: [10, -10, -540], size: [3, 16, 3] },
];

/** Timed course: fly the length of a winding tunnel, dodging its walls and a few jutting obstacles. */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = new THREE.Fog("#050608", 60, 400);
  scene.background = new THREE.Color("#050608");
  camera.far = 500;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(350, 480, 1500);
  scene.add(stars);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2.4, 90);
  scene.add(shipLight);

  const curve = new THREE.CatmullRomCurve3(
    WAYPOINTS.map((p) => new THREE.Vector3(...p)),
    false,
    "catmullrom",
    0.5,
  );
  const collisionSamples = curve.getSpacedPoints(220);

  const ribGeometry = new THREE.TorusGeometry(TUNNEL_RADIUS, 0.5, 8, 24);
  const ribMaterial = new THREE.MeshStandardMaterial({
    color: "#4da3ff",
    emissive: "#0b3a66",
    emissiveIntensity: 0.4,
    roughness: 0.5,
  });
  const RIB_COUNT = 45;
  const ribs: THREE.Mesh[] = [];
  for (let i = 0; i <= RIB_COUNT; i++) {
    const u = i / RIB_COUNT;
    const point = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u).normalize();
    const rib = new THREE.Mesh(ribGeometry, ribMaterial);
    rib.position.copy(point);
    rib.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
    scene.add(rib);
    ribs.push(rib);
  }

  const obstacleMaterial = new THREE.MeshStandardMaterial({
    color: "#ff5a4d",
    emissive: "#4d0f0a",
    emissiveIntensity: 0.5,
    roughness: 0.5,
  });
  const obstacles: Obstacle[] = OBSTACLE_DEFS.map((def) => {
    const size = new THREE.Vector3(...def.size);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), obstacleMaterial);
    const position = new THREE.Vector3(...def.position);
    mesh.position.copy(position);
    scene.add(mesh);
    return { mesh, position, halfSize: size.multiplyScalar(0.5) };
  });

  const startTangent = curve.getTangentAt(0).normalize();
  const startQuaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), startTangent);

  const rig = new FlightRig(canvas);
  rig.reset(WAYPOINTS[0], startQuaternion);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const compass = new CompassHUD(120);
  const timer = new CourseTimer({ storageKey: "course-best:structure-run" });
  const hitFlash = new HitFlash();
  const finishPosition = new THREE.Vector3(...WAYPOINTS[WAYPOINTS.length - 1]);

  let invulnerable = 0;

  function restart(): void {
    rig.reset(WAYPOINTS[0], startQuaternion);
    invulnerable = 0;
    timer.restart();
  }

  rig.registerControls(gui);
  gui.add(timer, "statusText").name("Status").listen().disable();
  gui.add(timer, "timeText").name("Time").listen().disable();
  gui.add(timer, "hits").name("Hits").listen().disable();
  gui.add(timer, "bestText").name("Best").listen().disable();
  gui.add({ restart }, "restart").name("Restart");

  function applyHit(pushDir: THREE.Vector3): void {
    if (invulnerable > 0) return;
    timer.addPenalty(HIT_PENALTY_MS);
    invulnerable = INVULN_SECONDS;
    hitFlash.trigger();
    rig.position.addScaledVector(pushDir, 2.5);
    const intoObstacle = rig.velocity.dot(pushDir);
    if (intoObstacle < 0) rig.velocity.addScaledVector(pushDir, -intoObstacle);
  }

  function checkCollisions(): void {
    let nearest = Infinity;
    let nearestPoint = collisionSamples[0];
    for (const sample of collisionSamples) {
      const d = sample.distanceToSquared(rig.position);
      if (d < nearest) {
        nearest = d;
        nearestPoint = sample;
      }
    }
    const distToWall = Math.sqrt(nearest);
    if (distToWall > TUNNEL_RADIUS - SHIP_RADIUS) {
      const pushDir = rig.position.clone().sub(nearestPoint).normalize();
      applyHit(pushDir);
      return;
    }

    for (const obstacle of obstacles) {
      const dx = Math.abs(rig.position.x - obstacle.position.x);
      const dy = Math.abs(rig.position.y - obstacle.position.y);
      const dz = Math.abs(rig.position.z - obstacle.position.z);
      if (
        dx < obstacle.halfSize.x + SHIP_RADIUS &&
        dy < obstacle.halfSize.y + SHIP_RADIUS &&
        dz < obstacle.halfSize.z + SHIP_RADIUS
      ) {
        const pushDir = rig.position.clone().sub(obstacle.position).normalize();
        applyHit(pushDir);
        return;
      }
    }
  }

  return {
    manualCamera: true,
    update(delta) {
      if (timer.state !== "countdown") rig.update(delta);
      timer.update(delta);
      if (invulnerable > 0) invulnerable -= delta;

      if (timer.state === "racing") {
        checkCollisions();
        if (rig.position.distanceTo(finishPosition) < FINISH_RADIUS) timer.finish();
      }

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      compass.update(camera, [{ label: "Finish", color: "#8fe3a0", position: finishPosition }], delta);
    },
    dispose() {
      rig.dispose();
      compass.dispose();
      hitFlash.dispose();

      ribGeometry.dispose();
      ribMaterial.dispose();
      ribs.forEach((rib) => scene.remove(rib));

      obstacles.forEach((o) => scene.remove(o.mesh));
      obstacleMaterial.dispose();
      obstacles.forEach((o) => o.mesh.geometry.dispose());

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

export const structureRunScene: TestScene = {
  id: "structure-run",
  name: "Course: Structure Run",
  description: "Timed run through a winding tunnel — avoid the walls and jutting obstacles.",
  setup,
};
