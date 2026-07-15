import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { ScannerHUD } from "../core/scanner-hud.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { HitFlash } from "../core/hit-flash.ts";
import { buildStarfield } from "../core/starfield.ts";

const SHIP_RADIUS = 3;
const BASE_ROCK_RADIUS = 4;
const LASER_SPEED = 220;
const LASER_LIFETIME = 1.2;
const FIRE_COOLDOWN = 0.22;
const INVULN_SECONDS = 1.2;
const START_LIVES = 3;
const SCANNER_MAX_TARGETS = 8;
const SWIPE_THRESHOLD_PX = 28;
const BEST_SCORE_KEY = "course-best:asteroids-arena-score";

type AsteroidSize = "large" | "medium" | "small";

const SIZE_DEFS: Record<AsteroidSize, { radius: number; scoreValue: number; splitInto: AsteroidSize | null; splitCount: number; color: string }> = {
  large: { radius: 14, scoreValue: 20, splitInto: "medium", splitCount: 2, color: "#ff6b6b" },
  medium: { radius: 8, scoreValue: 50, splitInto: "small", splitCount: 2, color: "#ffd24d" },
  small: { radius: 4, scoreValue: 100, splitInto: null, splitCount: 0, color: "#8fe3a0" },
};

interface Asteroid {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  size: AsteroidSize;
  radius: number;
}

interface Laser {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  age: number;
}

function randomVelocity(speedMin: number, speedMax: number): THREE.Vector3 {
  const speed = THREE.MathUtils.lerp(speedMin, speedMax, Math.random());
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  return new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)).multiplyScalar(speed);
}

/**
 * Classic Asteroids, in 3D: fly the field, fire a forward laser (the center
 * reticle is your sight), and watch large rocks split into medium, medium
 * into small. Clearing every rock spawns the next (larger) wave; running out
 * of lives ends the run. The scanner shows the nearest rocks color-coded by
 * size, so you can pick targets before they're even in view.
 */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = new THREE.Fog("#02030a", 80, 480);
  scene.background = new THREE.Color("#02030a");
  camera.far = 550;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(400, 520, 2500);
  scene.add(stars);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2.4, 100);
  scene.add(shipLight);

  const rockGeometry = new THREE.IcosahedronGeometry(BASE_ROCK_RADIUS, 0);
  const rockMaterial = new THREE.MeshStandardMaterial({ color: "#8a7a6a", roughness: 0.9, flatShading: true });
  const laserGeometry = new THREE.CylinderGeometry(0.25, 0.25, 4, 6);
  const laserMaterial = new THREE.MeshStandardMaterial({ color: "#8fe3a0", emissive: "#2f7a45", emissiveIntensity: 1.4 });

  const rig = new FlightRig(canvas);
  rig.reset([0, 0, 0]);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const scanner = new ScannerHUD(150, 220);
  const hitFlash = new HitFlash();

  const asteroids: Asteroid[] = [];
  const lasers: Laser[] = [];

  let state: "countdown" | "playing" | "gameover" = "countdown";
  let countdownRemaining = 3;
  let invulnerable = 0;
  let fireCooldown = 0;
  let score = 0;
  let lives = START_LIVES;
  let wave = 0;

  const storedBest = Number(localStorage.getItem(BEST_SCORE_KEY));
  let bestScore = Number.isFinite(storedBest) ? storedBest : 0;

  const readout = {
    status: "Get ready…",
    score: 0,
    lives: START_LIVES,
    wave: 0,
    best: bestScore > 0 ? String(bestScore) : "—",
  };

  function spawnAsteroid(size: AsteroidSize, position: THREE.Vector3, inheritedVelocity?: THREE.Vector3): void {
    const def = SIZE_DEFS[size];
    const mesh = new THREE.Mesh(rockGeometry, rockMaterial);
    mesh.scale.setScalar(def.radius / BASE_ROCK_RADIUS);
    mesh.position.copy(position);
    scene.add(mesh);
    // Split fragments dampen the parent's velocity rather than fully carrying
    // it forward, so speed doesn't compound across generations (large ->
    // medium -> small would otherwise stack a fresh random impulse on top of
    // an already-boosted velocity and send small rocks rocketing away).
    const velocity = inheritedVelocity ? inheritedVelocity.clone().multiplyScalar(0.5).add(randomVelocity(3, 7)) : randomVelocity(3, 8);
    const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4);
    asteroids.push({ mesh, velocity, spin, size, radius: def.radius });
  }

  function startNextWave(): void {
    wave += 1;
    const count = Math.min(4 + wave, 12);
    for (let i = 0; i < count; i++) {
      const dir = randomVelocity(1, 1).normalize();
      const dist = THREE.MathUtils.lerp(90, 220, Math.random());
      spawnAsteroid("large", rig.position.clone().addScaledVector(dir, dist));
    }
    readout.wave = wave;
  }

  function splitAsteroid(asteroid: Asteroid): void {
    const def = SIZE_DEFS[asteroid.size];
    score += def.scoreValue;
    readout.score = score;
    if (def.splitInto) {
      for (let i = 0; i < def.splitCount; i++) spawnAsteroid(def.splitInto, asteroid.mesh.position, asteroid.velocity);
    }
    scene.remove(asteroid.mesh);
    const idx = asteroids.indexOf(asteroid);
    if (idx >= 0) asteroids.splice(idx, 1);
  }

  function gameOver(): void {
    state = "gameover";
    readout.status = `GAME OVER — Score ${score}`;
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
      readout.best = `${bestScore} (new best!)`;
    }
  }

  function loseLife(asteroid: Asteroid): void {
    if (invulnerable > 0) return;
    lives -= 1;
    readout.lives = lives;
    invulnerable = INVULN_SECONDS;
    hitFlash.trigger();
    const pushDir = rig.position.clone().sub(asteroid.mesh.position).normalize();
    rig.position.addScaledVector(pushDir, 4);
    const into = rig.velocity.dot(pushDir);
    if (into < 0) rig.velocity.addScaledVector(pushDir, -into);
    if (lives <= 0) gameOver();
  }

  function fireLaser(): void {
    if (state !== "playing" || fireCooldown > 0) return;
    fireCooldown = FIRE_COOLDOWN;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.quaternion);
    const mesh = new THREE.Mesh(laserGeometry, laserMaterial);
    mesh.position.copy(rig.position).addScaledVector(forward, SHIP_RADIUS + 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), forward);
    scene.add(mesh);
    lasers.push({ mesh, velocity: forward.multiplyScalar(LASER_SPEED), age: 0 });
  }

  function restart(): void {
    rig.reset([0, 0, 0]);
    asteroids.forEach((a) => scene.remove(a.mesh));
    asteroids.length = 0;
    lasers.forEach((l) => scene.remove(l.mesh));
    lasers.length = 0;
    score = 0;
    lives = START_LIVES;
    wave = 0;
    invulnerable = 0;
    fireCooldown = 0;
    readout.score = 0;
    readout.lives = START_LIVES;
    readout.wave = 0;
    readout.status = "Get ready…";
    state = "countdown";
    countdownRemaining = 3;
  }

  // A big bottom-left corner zone rather than a small precise button — easy
  // to hit without looking away from aiming. A quick tap fires once; a swipe
  // (up to arm, down to disarm) toggles auto-fire, so the thumb can leave the
  // zone entirely and keep steering while the ship fires on its own cooldown.
  const fireZone = document.createElement("div");
  fireZone.className = "fire-zone";
  fireZone.innerHTML = '<span class="fire-zone-label">FIRE</span>';
  document.body.appendChild(fireZone);
  const fireZoneLabel = fireZone.querySelector(".fire-zone-label") as HTMLSpanElement;

  let autoFire = false;
  let fireGestureId: number | null = null;
  let fireGestureStart = { x: 0, y: 0 };

  function setAutoFire(on: boolean): void {
    autoFire = on;
    fireZone.classList.toggle("autofire", on);
    fireZoneLabel.textContent = on ? "AUTO ON\n(swipe down to stop)" : "FIRE\n(swipe up to lock)";
  }
  setAutoFire(false);

  const onFireZonePointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    if (fireGestureId !== null) return;
    fireGestureId = e.pointerId;
    fireGestureStart = { x: e.clientX, y: e.clientY };
  };
  const onFireZonePointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== fireGestureId) return;
    fireGestureId = null;
    const dx = e.clientX - fireGestureStart.x;
    const dy = e.clientY - fireGestureStart.y;
    if (Math.abs(dy) > SWIPE_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
      setAutoFire(dy < 0); // swipe up arms it, swipe down disarms it
    } else {
      fireLaser();
    }
  };
  const onFireZonePointerCancel = (e: PointerEvent): void => {
    if (e.pointerId === fireGestureId) fireGestureId = null;
  };
  fireZone.addEventListener("pointerdown", onFireZonePointerDown);
  fireZone.addEventListener("pointerup", onFireZonePointerUp);
  fireZone.addEventListener("pointercancel", onFireZonePointerCancel);

  rig.registerControls(gui);
  gui.add(readout, "status").name("Status").listen().disable();
  gui.add(readout, "score").name("Score").listen().disable();
  gui.add(readout, "lives").name("Lives").listen().disable();
  gui.add(readout, "wave").name("Wave").listen().disable();
  gui.add(readout, "best").name("Best score").listen().disable();
  gui.add({ restart }, "restart").name("Restart");

  return {
    manualCamera: true,
    update(delta) {
      if (state !== "countdown") rig.update(delta);
      if (fireCooldown > 0) fireCooldown -= delta;
      if (invulnerable > 0) invulnerable -= delta;
      if (autoFire) fireLaser();

      if (state === "countdown") {
        countdownRemaining -= delta;
        if (countdownRemaining > 0) {
          readout.status = `${Math.ceil(countdownRemaining)}…`;
        } else {
          state = "playing";
          readout.status = "Fly & Fire";
          startNextWave();
        }
      }

      if (state === "playing") {
        for (let i = lasers.length - 1; i >= 0; i--) {
          const laser = lasers[i];
          laser.mesh.position.addScaledVector(laser.velocity, delta);
          laser.age += delta;
          if (laser.age > LASER_LIFETIME) {
            scene.remove(laser.mesh);
            lasers.splice(i, 1);
            continue;
          }
          for (let j = asteroids.length - 1; j >= 0; j--) {
            const asteroid = asteroids[j];
            if (laser.mesh.position.distanceTo(asteroid.mesh.position) < asteroid.radius) {
              scene.remove(laser.mesh);
              lasers.splice(i, 1);
              splitAsteroid(asteroid);
              break;
            }
          }
        }

        for (const asteroid of asteroids) {
          asteroid.mesh.position.addScaledVector(asteroid.velocity, delta);
          asteroid.mesh.rotation.x += asteroid.spin.x * delta;
          asteroid.mesh.rotation.y += asteroid.spin.y * delta;
          asteroid.mesh.rotation.z += asteroid.spin.z * delta;

          if (invulnerable <= 0 && asteroid.mesh.position.distanceTo(rig.position) < asteroid.radius + SHIP_RADIUS) {
            loseLife(asteroid);
          }
        }

        if (asteroids.length === 0) startNextWave();
      }

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      const nearest = [...asteroids]
        .sort((a, b) => a.mesh.position.distanceTo(rig.position) - b.mesh.position.distanceTo(rig.position))
        .slice(0, SCANNER_MAX_TARGETS);
      scanner.update(
        rig.position,
        rig.quaternion,
        nearest.map((a) => ({ label: a.size, color: SIZE_DEFS[a.size].color, position: a.mesh.position })),
      );
    },
    dispose() {
      rig.dispose();
      scanner.dispose();
      hitFlash.dispose();
      fireZone.removeEventListener("pointerdown", onFireZonePointerDown);
      fireZone.removeEventListener("pointerup", onFireZonePointerUp);
      fireZone.removeEventListener("pointercancel", onFireZonePointerCancel);
      fireZone.remove();

      rockGeometry.dispose();
      rockMaterial.dispose();
      laserGeometry.dispose();
      laserMaterial.dispose();
      asteroids.forEach((a) => scene.remove(a.mesh));
      lasers.forEach((l) => scene.remove(l.mesh));

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

export const asteroidsArenaScene: TestScene = {
  id: "asteroids-arena",
  name: "Course: Asteroids Arena",
  description: "Fly, fire, and split rocks large to medium to small — nearest rocks shown on the Elite scanner.",
  setup,
};
