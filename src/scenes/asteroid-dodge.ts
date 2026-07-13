import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { CompassHUD } from "../core/compass-hud.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { CourseTimer } from "../core/course-timer.ts";
import { HitFlash } from "../core/hit-flash.ts";
import { buildStarfield } from "../core/starfield.ts";
import { crossedPlane } from "../core/plane-crossing.ts";

const SHIP_RADIUS = 3;
const BASE_ROCK_RADIUS = 4;
const POOL_SIZE = 30;
const COURSE_LENGTH = 600;
const GATE_RADIUS = 30;
const GATE_PASS_RADIUS = GATE_RADIUS - SHIP_RADIUS;
const HIT_PENALTY_MS = 1500;
const INVULN_SECONDS = 0.6;
const CORRIDOR_RADIUS = 55; // lateral spawn/despawn spread from the centerline

interface Asteroid {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  radius: number;
  spin: THREE.Vector3;
}

function respawnAsteroid(asteroid: Asteroid, aheadOfZ: number): void {
  const z = aheadOfZ - THREE.MathUtils.lerp(80, 260, Math.random());
  const x = THREE.MathUtils.lerp(-CORRIDOR_RADIUS, CORRIDOR_RADIUS, Math.random());
  const y = THREE.MathUtils.lerp(-CORRIDOR_RADIUS * 0.8, CORRIDOR_RADIUS * 0.8, Math.random());
  asteroid.mesh.position.set(x, y, z);

  const speed = THREE.MathUtils.lerp(4, 14, Math.random());
  const angle = Math.random() * Math.PI * 2;
  asteroid.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed * 0.6, (Math.random() - 0.5) * 4);

  asteroid.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.2);

  const scaleFactor = THREE.MathUtils.lerp(0.7, 1.9, Math.random());
  asteroid.mesh.scale.setScalar(scaleFactor);
  asteroid.radius = BASE_ROCK_RADIUS * scaleFactor;
}

/** Timed course: fly from start to the finish marker through a continuously-respawning field of drifting rocks. */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = new THREE.Fog("#050608", 60, 420);
  scene.background = new THREE.Color("#050608");
  camera.far = 500;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(360, 480, 1500);
  scene.add(stars);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2.4, 90);
  scene.add(shipLight);

  const rockGeometry = new THREE.IcosahedronGeometry(BASE_ROCK_RADIUS, 0);
  const rockMaterial = new THREE.MeshStandardMaterial({ color: "#8a7a6a", roughness: 0.9, flatShading: true });

  const asteroids: Asteroid[] = Array.from({ length: POOL_SIZE }, () => {
    const mesh = new THREE.Mesh(rockGeometry, rockMaterial);
    scene.add(mesh);
    const asteroid: Asteroid = { mesh, velocity: new THREE.Vector3(), radius: BASE_ROCK_RADIUS, spin: new THREE.Vector3() };
    return asteroid;
  });
  // Spread the initial population across the whole course, not bunched at the start.
  asteroids.forEach((a, i) => {
    respawnAsteroid(a, 0);
    a.mesh.position.z = -THREE.MathUtils.lerp(40, COURSE_LENGTH - 20, (i + Math.random()) / POOL_SIZE);
  });

  const gateGeometry = new THREE.TorusGeometry(GATE_RADIUS, 2, 10, 40);
  const gateMaterial = new THREE.MeshStandardMaterial({
    color: "#8fe3a0",
    emissive: "#1c5c33",
    emissiveIntensity: 0.6,
    roughness: 0.4,
  });
  const gateMesh = new THREE.Mesh(gateGeometry, gateMaterial);
  const finishPosition = new THREE.Vector3(0, 0, -COURSE_LENGTH);
  const gateNormal = new THREE.Vector3(0, 0, 1);
  gateMesh.position.copy(finishPosition);
  scene.add(gateMesh);

  const rig = new FlightRig(canvas);
  rig.reset([0, 0, 0]);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);
  const prevShipPos = rig.position.clone();

  const compass = new CompassHUD(120);
  const timer = new CourseTimer({ storageKey: "course-best:asteroid-dodge" });
  const hitFlash = new HitFlash();

  let invulnerable = 0;

  function restart(): void {
    rig.reset([0, 0, 0]);
    prevShipPos.copy(rig.position);
    invulnerable = 0;
    timer.restart();
    asteroids.forEach((a, i) => {
      respawnAsteroid(a, 0);
      a.mesh.position.z = -THREE.MathUtils.lerp(40, COURSE_LENGTH - 20, (i + Math.random()) / POOL_SIZE);
    });
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
    rig.position.addScaledVector(pushDir, 2);
    const intoRock = rig.velocity.dot(pushDir);
    if (intoRock < 0) rig.velocity.addScaledVector(pushDir, -intoRock);
  }

  return {
    manualCamera: true,
    update(delta) {
      if (timer.state !== "countdown") rig.update(delta);
      timer.update(delta);
      if (invulnerable > 0) invulnerable -= delta;

      for (const asteroid of asteroids) {
        asteroid.mesh.position.addScaledVector(asteroid.velocity, delta);
        asteroid.mesh.rotation.x += asteroid.spin.x * delta;
        asteroid.mesh.rotation.y += asteroid.spin.y * delta;
        asteroid.mesh.rotation.z += asteroid.spin.z * delta;

        const passedBehind = asteroid.mesh.position.z > rig.position.z + 30;
        const lateralDist = Math.hypot(asteroid.mesh.position.x, asteroid.mesh.position.y);
        if (passedBehind || lateralDist > CORRIDOR_RADIUS * 1.6) {
          respawnAsteroid(asteroid, rig.position.z);
          continue;
        }

        if (timer.state === "racing" && invulnerable <= 0) {
          const dist = asteroid.mesh.position.distanceTo(rig.position);
          if (dist < asteroid.radius + SHIP_RADIUS) {
            applyHit(rig.position.clone().sub(asteroid.mesh.position).normalize());
            respawnAsteroid(asteroid, rig.position.z);
          }
        }
      }

      if (timer.state === "racing" && crossedPlane(prevShipPos, rig.position, finishPosition, gateNormal, GATE_PASS_RADIUS)) {
        timer.finish();
      }
      prevShipPos.copy(rig.position);

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      const pulse = 0.6 + Math.sin(performance.now() / 200) * 0.4;
      gateMaterial.emissiveIntensity = 0.5 + pulse;

      compass.update(camera, [{ label: "Finish", color: "#8fe3a0", position: finishPosition }], delta);
    },
    dispose() {
      rig.dispose();
      compass.dispose();
      hitFlash.dispose();

      gateGeometry.dispose();
      gateMaterial.dispose();
      scene.remove(gateMesh);

      rockGeometry.dispose();
      rockMaterial.dispose();
      asteroids.forEach((a) => scene.remove(a.mesh));

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

export const asteroidDodgeScene: TestScene = {
  id: "asteroid-dodge",
  name: "Course: Asteroid Shower",
  description: "Timed run to the finish marker, dodging a continuous field of drifting rocks.",
  setup,
};
