import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { ScannerHUD } from "../core/scanner-hud.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { HitFlash } from "../core/hit-flash.ts";
import { FireZone } from "../core/fire-zone.ts";
import { buildStarfield } from "../core/starfield.ts";
import { segmentHitsSphere } from "../core/swept-hit.ts";

const SHIP_RADIUS = 3;
const LASER_SPEED = 220;
const LASER_LIFETIME = 1.2;
const FIRE_COOLDOWN = 0.22;
const INVULN_SECONDS = 1.2;
const START_LIVES = 3;
const BEST_SCORE_KEY = "course-best:saucer-duel-score";

const SAUCER_RADIUS = 7;
const SAUCER_HP = 3;
const SAUCER_SCORE_PER_HIT = 40;
const SAUCER_KILL_BONUS = 60;
const SAUCER_BASE_MAX_SPEED = 28;
const SAUCER_SPEED_PER_KILL = 2;
const SAUCER_MAX_SPEED_CAP = 46;
// Keeps a rough standoff band rather than beelining for the player — closer
// than this it backs off, farther than this it closes in, and in between it
// strafes. Not real tactics, just enough to read as "maneuvering".
const SAUCER_MIN_RANGE = 45;
const SAUCER_MAX_RANGE = 100;
const SAUCER_FIRE_RANGE = 150;
// If a player laser's closest approach to the saucer (within this look-ahead
// window) would pass inside this radius, dodge perpendicular to its path.
const SAUCER_EVADE_LOOKAHEAD = 0.7;
const SAUCER_EVADE_RADIUS = 20;
const SAUCER_EVADE_DURATION = 0.55;
const SAUCER_FIRE_COOLDOWN_MIN_BASE = 1.0;
const SAUCER_FIRE_COOLDOWN_MAX_BASE = 1.9;
const SAUCER_FIRE_COOLDOWN_SHRINK_PER_KILL = 0.05;
const SAUCER_FIRE_COOLDOWN_FLOOR = 0.6;
// Random cone half-angle around the true aim direction — "an approximation,
// not a precise shooter", per the ask.
const SAUCER_AIM_INACCURACY_DEG = 9;
const SAUCER_LASER_SPEED = 150;
const SAUCER_LASER_LIFETIME = 1.6;
const RESPAWN_DELAY = 1.8;
const SAUCER_SPAWN_MIN_DIST = 90;
const SAUCER_SPAWN_MAX_DIST = 160;
const SAUCER_HIT_GLOW_DECAY = 1 / 0.25; // per second

interface Saucer {
  group: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  maxSpeed: number;
  hp: number;
  fireCooldown: number;
  strafeDir: THREE.Vector3;
  strafeTimer: number;
  evadeDir: THREE.Vector3 | null;
  evadeTimer: number;
}

interface Laser {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  age: number;
}

function randomDirection(): THREE.Vector3 {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  return new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));
}

// Scratch objects reused every frame instead of allocating fresh Vector3s —
// each is written immediately before it's read and never escapes past that
// use, so sharing them at module scope is safe on this single-threaded loop.
// Anything that gets stored as persistent per-saucer state (evadeDir,
// strafeDir) still gets its own `new THREE.Vector3()` — see the comments at
// those call sites.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const playerLaserFrom = new THREE.Vector3();
const enemyLaserFrom = new THREE.Vector3();
const aiToPlayer = new THREE.Vector3();
const aiToPlayerDir = new THREE.Vector3();
const aiRel = new THREE.Vector3();
const aiClosest = new THREE.Vector3();
const aiDesired = new THREE.Vector3();
const ramPushDir = new THREE.Vector3();

/**
 * A one-on-one duel against a single flying saucer: it holds a rough standoff
 * distance while strafing, dodges perpendicular to any player laser whose
 * predicted closest approach comes too close, and fires back with a laser
 * aimed at the player plus a random inaccuracy cone — an approximation of a
 * dogfight rather than a precise shooter on either side. Destroying it (three
 * hits) scores and spawns a tougher one shortly after; its fire can knock
 * lives off the player the same way asteroid collisions do elsewhere.
 */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = new THREE.Fog("#050212", 80, 480);
  scene.background = new THREE.Color("#050212");
  camera.far = 550;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(400, 520, 2500);
  scene.add(stars);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2.4, 100);
  scene.add(shipLight);

  const saucerBodyGeometry = new THREE.SphereGeometry(1, 20, 12);
  const saucerDomeGeometry = new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const saucerBodyMaterial = new THREE.MeshStandardMaterial({ color: "#9aa6b8", metalness: 0.6, roughness: 0.35 });
  const saucerDomeMaterial = new THREE.MeshStandardMaterial({
    color: "#7dd3fc",
    metalness: 0.2,
    roughness: 0.15,
    emissive: "#1b4a5c",
    emissiveIntensity: 0.6,
  });

  function buildSaucerGroup(): THREE.Group {
    const group = new THREE.Group();
    const body = new THREE.Mesh(saucerBodyGeometry, saucerBodyMaterial);
    body.scale.set(SAUCER_RADIUS, SAUCER_RADIUS * 0.32, SAUCER_RADIUS);
    group.add(body);
    const dome = new THREE.Mesh(saucerDomeGeometry, saucerDomeMaterial);
    dome.scale.setScalar(SAUCER_RADIUS * 0.5);
    dome.position.y = SAUCER_RADIUS * 0.12;
    group.add(dome);
    return group;
  }

  const playerLaserGeometry = new THREE.CylinderGeometry(0.25, 0.25, 4, 6);
  const playerLaserMaterial = new THREE.MeshStandardMaterial({ color: "#8fe3a0", emissive: "#2f7a45", emissiveIntensity: 1.4 });
  const enemyLaserGeometry = new THREE.CylinderGeometry(0.25, 0.25, 4, 6);
  const enemyLaserMaterial = new THREE.MeshStandardMaterial({ color: "#ff3b5c", emissive: "#7a0f26", emissiveIntensity: 1.4 });

  const rig = new FlightRig(canvas);
  rig.reset([0, 0, 0]);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const scanner = new ScannerHUD(150, 220);
  const hitFlash = new HitFlash();
  const fireZone = new FireZone(document.body);

  const playerLasers: Laser[] = [];
  const enemyLasers: Laser[] = [];
  let saucer: Saucer | null = null;
  let respawnTimer = 0;
  let hitGlow = 0;

  let state: "countdown" | "playing" | "gameover" = "countdown";
  let countdownRemaining = 3;
  let invulnerable = 0;
  let fireCooldown = 0;
  let score = 0;
  let lives = START_LIVES;
  let kills = 0;

  const storedBest = Number(localStorage.getItem(BEST_SCORE_KEY));
  let bestScore = Number.isFinite(storedBest) ? storedBest : 0;

  const readout = {
    status: "Get ready…",
    score: 0,
    lives: START_LIVES,
    kills: 0,
    best: bestScore > 0 ? String(bestScore) : "—",
  };

  function spawnSaucer(): void {
    const position = rig.position.clone().addScaledVector(randomDirection(), THREE.MathUtils.lerp(SAUCER_SPAWN_MIN_DIST, SAUCER_SPAWN_MAX_DIST, Math.random()));
    const group = buildSaucerGroup();
    group.position.copy(position);
    scene.add(group);
    saucer = {
      group,
      position,
      velocity: new THREE.Vector3(),
      maxSpeed: Math.min(SAUCER_MAX_SPEED_CAP, SAUCER_BASE_MAX_SPEED + kills * SAUCER_SPEED_PER_KILL),
      hp: SAUCER_HP,
      fireCooldown: THREE.MathUtils.lerp(0.4, 1.0, Math.random()),
      strafeDir: new THREE.Vector3(1, 0, 0),
      strafeTimer: 0,
      evadeDir: null,
      evadeTimer: 0,
    };
  }

  function fireEnemyLaser(from: Saucer): void {
    const aim = rig.position.clone().sub(from.position).normalize();
    const jitterAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    if (jitterAxis.lengthSq() < 1e-6) jitterAxis.set(0, 1, 0);
    jitterAxis.normalize();
    const jitterAngle = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(-SAUCER_AIM_INACCURACY_DEG, SAUCER_AIM_INACCURACY_DEG, Math.random()));
    aim.applyAxisAngle(jitterAxis, jitterAngle);
    const mesh = new THREE.Mesh(enemyLaserGeometry, enemyLaserMaterial);
    mesh.position.copy(from.position).addScaledVector(aim, SAUCER_RADIUS + 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim);
    scene.add(mesh);
    enemyLasers.push({ mesh, velocity: aim.multiplyScalar(SAUCER_LASER_SPEED), age: 0 });
  }

  function updateSaucerAI(active: Saucer, delta: number): void {
    aiToPlayer.subVectors(rig.position, active.position);
    const dist = aiToPlayer.length();
    const toPlayerDir = dist > 0.0001 ? aiToPlayerDir.copy(aiToPlayer).normalize() : aiToPlayerDir.set(0, 0, -1);

    if (active.evadeTimer <= 0) {
      for (const laser of playerLasers) {
        const speed2 = laser.velocity.lengthSq();
        if (speed2 < 1e-6) continue;
        aiRel.subVectors(active.position, laser.mesh.position);
        const t = THREE.MathUtils.clamp(aiRel.dot(laser.velocity) / speed2, 0, SAUCER_EVADE_LOOKAHEAD);
        aiClosest.copy(laser.mesh.position).addScaledVector(laser.velocity, t);
        if (aiClosest.distanceTo(active.position) < SAUCER_EVADE_RADIUS) {
          // Assigned to active.evadeDir below (persistent per-saucer state
          // read again next frame), so this must stay its own allocation
          // rather than a reused scratch object.
          const lateral = new THREE.Vector3().crossVectors(laser.velocity, WORLD_UP);
          if (lateral.lengthSq() < 1e-6) lateral.set(1, 0, 0);
          lateral.normalize();
          aiRel.subVectors(active.position, aiClosest); // rel's earlier value is no longer needed; reused for the side test
          const side = aiRel.dot(lateral) < 0 ? -1 : 1;
          active.evadeDir = lateral.multiplyScalar(side);
          active.evadeTimer = SAUCER_EVADE_DURATION;
          break;
        }
      }
    }

    if (active.evadeTimer > 0) {
      active.evadeTimer -= delta;
      if (active.evadeDir) aiDesired.copy(active.evadeDir).multiplyScalar(active.maxSpeed);
      else aiDesired.set(0, 0, 0);
    } else {
      active.strafeTimer -= delta;
      if (active.strafeTimer <= 0) {
        // Assigned to active.strafeDir below (persistent per-saucer state),
        // same reasoning as the evadeDir lateral above.
        const lateral = new THREE.Vector3().crossVectors(toPlayerDir, WORLD_UP);
        if (lateral.lengthSq() < 1e-6) lateral.set(1, 0, 0);
        lateral.normalize().multiplyScalar(Math.random() < 0.5 ? 1 : -1);
        active.strafeDir = lateral;
        active.strafeTimer = THREE.MathUtils.lerp(1.2, 2.6, Math.random());
      }
      let radial = 0;
      if (dist < SAUCER_MIN_RANGE) radial = -1;
      else if (dist > SAUCER_MAX_RANGE) radial = 1;
      aiDesired.copy(toPlayerDir).multiplyScalar(radial * 0.9).addScaledVector(active.strafeDir, 0.8);
      if (aiDesired.lengthSq() > 1e-6) aiDesired.normalize().multiplyScalar(active.maxSpeed);
      else aiDesired.set(0, 0, 0);
    }

    active.velocity.lerp(aiDesired, 1 - Math.pow(0.001, delta));
    active.position.addScaledVector(active.velocity, delta);
    active.group.position.copy(active.position);
    active.group.lookAt(rig.position);

    if (active.fireCooldown > 0) active.fireCooldown -= delta;
    if (active.fireCooldown <= 0 && dist <= SAUCER_FIRE_RANGE && active.evadeTimer <= 0) {
      fireEnemyLaser(active);
      const minCd = Math.max(SAUCER_FIRE_COOLDOWN_FLOOR, SAUCER_FIRE_COOLDOWN_MIN_BASE - kills * SAUCER_FIRE_COOLDOWN_SHRINK_PER_KILL);
      const maxCd = Math.max(minCd + 0.2, SAUCER_FIRE_COOLDOWN_MAX_BASE - kills * SAUCER_FIRE_COOLDOWN_SHRINK_PER_KILL);
      active.fireCooldown = THREE.MathUtils.lerp(minCd, maxCd, Math.random());
    }
  }

  function damageSaucer(active: Saucer): void {
    active.hp -= 1;
    score += SAUCER_SCORE_PER_HIT;
    readout.score = score;
    hitGlow = 1;
    if (active.hp <= 0) {
      kills += 1;
      score += SAUCER_KILL_BONUS;
      readout.score = score;
      readout.kills = kills;
      scene.remove(active.group);
      saucer = null;
      respawnTimer = RESPAWN_DELAY;
    }
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

  function loseLife(pushDir: THREE.Vector3): void {
    if (invulnerable > 0) return;
    lives -= 1;
    readout.lives = lives;
    invulnerable = INVULN_SECONDS;
    hitFlash.trigger();
    rig.position.addScaledVector(pushDir, 4);
    const into = rig.velocity.dot(pushDir);
    if (into < 0) rig.velocity.addScaledVector(pushDir, -into);
    if (lives <= 0) gameOver();
  }

  function firePlayerLaser(): void {
    if (state !== "playing" || fireCooldown > 0) return;
    fireCooldown = FIRE_COOLDOWN;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.quaternion);
    const mesh = new THREE.Mesh(playerLaserGeometry, playerLaserMaterial);
    mesh.position.copy(rig.position).addScaledVector(forward, SHIP_RADIUS + 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), forward);
    scene.add(mesh);
    playerLasers.push({ mesh, velocity: forward.multiplyScalar(LASER_SPEED), age: 0 });
  }

  function restart(): void {
    rig.reset([0, 0, 0]);
    playerLasers.forEach((l) => scene.remove(l.mesh));
    playerLasers.length = 0;
    enemyLasers.forEach((l) => scene.remove(l.mesh));
    enemyLasers.length = 0;
    if (saucer) scene.remove(saucer.group);
    saucer = null;
    respawnTimer = 0;
    score = 0;
    lives = START_LIVES;
    kills = 0;
    invulnerable = 0;
    fireCooldown = 0;
    readout.score = 0;
    readout.lives = START_LIVES;
    readout.kills = 0;
    readout.status = "Get ready…";
    state = "countdown";
    countdownRemaining = 3;
  }

  rig.registerControls(gui);
  gui.add(readout, "status").name("Status").listen().disable();
  gui.add(readout, "score").name("Score").listen().disable();
  gui.add(readout, "lives").name("Lives").listen().disable();
  gui.add(readout, "kills").name("Kills").listen().disable();
  gui.add(readout, "best").name("Best score").listen().disable();
  gui.add({ restart }, "restart").name("Restart");

  return {
    manualCamera: true,
    update(delta) {
      if (state !== "countdown") rig.update(delta);
      if (fireCooldown > 0) fireCooldown -= delta;
      if (invulnerable > 0) invulnerable -= delta;
      if (hitGlow > 0) hitGlow = Math.max(0, hitGlow - delta * SAUCER_HIT_GLOW_DECAY);
      saucerDomeMaterial.emissiveIntensity = 0.6 + hitGlow * 2.2;
      if (fireZone.autoFire || fireZone.held) firePlayerLaser();

      if (state === "countdown") {
        countdownRemaining -= delta;
        if (countdownRemaining > 0) {
          readout.status = `${Math.ceil(countdownRemaining)}…`;
        } else {
          state = "playing";
          readout.status = "Fly & Fire";
          spawnSaucer();
        }
      }

      if (state === "playing") {
        for (let i = playerLasers.length - 1; i >= 0; i--) {
          const laser = playerLasers[i];
          // Point-sampling the post-move position can tunnel through the
          // saucer on a slow frame (220 u/s covers more ground per frame than
          // SAUCER_RADIUS) — sweep the segment travelled this frame instead.
          playerLaserFrom.copy(laser.mesh.position);
          laser.mesh.position.addScaledVector(laser.velocity, delta);
          laser.age += delta;
          if (laser.age > LASER_LIFETIME) {
            scene.remove(laser.mesh);
            playerLasers.splice(i, 1);
            continue;
          }
          if (saucer && segmentHitsSphere(playerLaserFrom, laser.mesh.position, saucer.position, SAUCER_RADIUS)) {
            scene.remove(laser.mesh);
            playerLasers.splice(i, 1);
            damageSaucer(saucer);
          }
        }

        for (let i = enemyLasers.length - 1; i >= 0; i--) {
          const laser = enemyLasers[i];
          enemyLaserFrom.copy(laser.mesh.position); // same tunneling concern as the player lasers above
          laser.mesh.position.addScaledVector(laser.velocity, delta);
          laser.age += delta;
          if (laser.age > SAUCER_LASER_LIFETIME) {
            scene.remove(laser.mesh);
            enemyLasers.splice(i, 1);
            continue;
          }
          if (invulnerable <= 0 && segmentHitsSphere(enemyLaserFrom, laser.mesh.position, rig.position, SHIP_RADIUS + 1.2)) {
            scene.remove(laser.mesh);
            enemyLasers.splice(i, 1);
            loseLife(laser.velocity.clone().normalize());
          }
        }

        // Ramming costs both sides: no dedicated projectile involved, so this
        // isn't covered by the swept laser checks above. Gated by invulnerable
        // the same way a laser hit is, so it can't re-trigger every frame
        // while the two are overlapping.
        if (saucer && invulnerable <= 0 && saucer.position.distanceTo(rig.position) < SAUCER_RADIUS + SHIP_RADIUS) {
          ramPushDir.subVectors(rig.position, saucer.position);
          if (ramPushDir.lengthSq() > 1e-8) ramPushDir.normalize();
          else ramPushDir.set(0, 0, 1);
          loseLife(ramPushDir);
          damageSaucer(saucer);
        }

        if (saucer) {
          updateSaucerAI(saucer, delta);
        } else {
          respawnTimer -= delta;
          if (respawnTimer <= 0) spawnSaucer();
        }
      }

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      scanner.update(rig.position, rig.quaternion, saucer ? [{ label: "saucer", color: "#c77dff", position: saucer.position }] : []);
    },
    dispose() {
      rig.dispose();
      scanner.dispose();
      hitFlash.dispose();
      fireZone.dispose();

      saucerBodyGeometry.dispose();
      saucerDomeGeometry.dispose();
      saucerBodyMaterial.dispose();
      saucerDomeMaterial.dispose();
      playerLaserGeometry.dispose();
      playerLaserMaterial.dispose();
      enemyLaserGeometry.dispose();
      enemyLaserMaterial.dispose();
      if (saucer) scene.remove(saucer.group);
      playerLasers.forEach((l) => scene.remove(l.mesh));
      enemyLasers.forEach((l) => scene.remove(l.mesh));

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

export const saucerDuelScene: TestScene = {
  id: "saucer-duel",
  name: "Course: Saucer Duel",
  description: "One-on-one dogfight against a flying saucer that dodges your fire and shoots back.",
  setup,
};
