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
const BEST_SCORE_KEY = "course-best:wedge-duel-score";

const FIGHTER_RADIUS = 6;
const FIGHTER_HP = 3;
const FIGHTER_SCORE_PER_HIT = 40;
const FIGHTER_KILL_BONUS = 60;
const FIGHTER_BASE_MAX_SPEED = 34;
const FIGHTER_SPEED_PER_KILL = 2;
const FIGHTER_MAX_SPEED_CAP = 50;
// The whole point of this one: it can only turn this fast (deg/sec), same as
// the player's look rate — reversing course costs an actual turn, not an
// instant retarget of its velocity vector.
const FIGHTER_TURN_RATE_DEG = 100;
// Turn rate scales with kills just like maxSpeed does — otherwise a "harder"
// (faster) fighter actually tracks worse, flying a wider turning circle.
const FIGHTER_TURN_PER_KILL = 4;
const FIGHTER_TURN_RATE_CAP = 140;
const FIGHTER_MAX_BANK_DEG = 42; // purely cosmetic roll into turns, doesn't affect physics
// Jousting pass ranges (hysteresis): inside BREAK it commits to extending past /
// away; only once beyond REENGAGE does it turn back in for another attack run.
// REENGAGE is deliberately long so the inbound pass has time for several
// nose-gun shots before it breaks off again.
const FIGHTER_BREAK_RANGE = 55;
const FIGHTER_REENGAGE_RANGE = 210;
const FIGHTER_FIRE_RANGE = 240;
// Guns are nose-mounted — fire only when the nose is truly on the
// intercept, not a wide cone (0.85 ≈ 32° used to "lock" while flying past).
const FIGHTER_FIRE_ALIGNMENT_MIN = 0.98; // ~11°
// At long range the player's angular size is tiny; demand a tighter lock
// beyond this distance so distant joust shots aren't wasted.
const FIGHTER_FIRE_TIGHT_RANGE = 120;
const FIGHTER_FIRE_ALIGNMENT_TIGHT = 0.995; // ~5.7°
// Bolt spray — kept small; at 200u even a few degrees is a clean miss.
const FIGHTER_AIM_INACCURACY_DEG = 1.5;
const FIGHTER_EVADE_LOOKAHEAD = 0.7;
const FIGHTER_EVADE_RADIUS = 20;
// While evading, the turn rate is boosted so the dodge reads as a distinct
// sharp jink rather than the same lazy arc it flies while orbiting.
const FIGHTER_EVADE_TURN_MULT = 1.6;
const FIGHTER_EVADE_MAX_DURATION = 1.8;
const FIGHTER_FIRE_COOLDOWN_MIN_BASE = 1.0;
const FIGHTER_FIRE_COOLDOWN_MAX_BASE = 1.9;
const FIGHTER_FIRE_COOLDOWN_SHRINK_PER_KILL = 0.05;
const FIGHTER_FIRE_COOLDOWN_FLOOR = 0.6;
const FIGHTER_LASER_SPEED = 150;
// Lifetime sized so bolts from FIRE_RANGE still reach (240 / 150 ≈ 1.6s).
const FIGHTER_LASER_LIFETIME = 1.8;
const RESPAWN_DELAY = 1.8;
const FIGHTER_SPAWN_MIN_DIST = 160;
const FIGHTER_SPAWN_MAX_DIST = 240;
const FIGHTER_HIT_GLOW_DECAY = 1 / 0.25; // per second

interface Fighter {
  group: THREE.Group;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  maxSpeed: number;
  turnRate: number; // deg/s, scales with kills (set at spawn)
  hp: number;
  fireCooldown: number;
  /** Attack run vs post-pass extend; hysteresis via BREAK/REENGAGE ranges. */
  phase: "attack" | "extend";
  strafeSign: number;
  strafeTimer: number;
  /** Roll of the pass-plane around the line to the player (extend slip axis). */
  orbitAzimuth: number;
  evadeDir: THREE.Vector3;
  evadeTimer: number;
  /** Smoothed cosmetic bank angle (rad), applied on top of the physics quat. */
  bankAngle: number;
  /** Hysteresis for bank direction so appliedRotation.y noise can't flip ±max bank in one frame. */
  bankSign: number;
}

interface Laser {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  age: number;
}

// Read-only unit references. NEVER mutate these — copy into scratch first.
const FORWARD = new THREE.Vector3(0, 0, -1);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);
const ROLL_AXIS = new THREE.Vector3(0, 0, 1);

// Per-frame scratch, hoisted to module scope to keep the AI/laser hot paths
// allocation-free (this repo is a mobile GC testbed). Single-threaded, so
// reuse is safe as long as no two live values alias the same object within a
// frame — each is traced to stay disjoint where it matters.
const _toPlayer = new THREE.Vector3();
const _toPlayerDir = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _closestPoint = new THREE.Vector3();
const _lateral = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _intercept = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _prevForward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _targetVelocity = new THREE.Vector3();
const _prevQuat = new THREE.Quaternion();
const _targetQuat = new THREE.Quaternion();
const _deltaQuat = new THREE.Quaternion();
const _appliedRotation = new THREE.Quaternion();
const _bankQuat = new THREE.Quaternion();
const _prevGroupQuat = new THREE.Quaternion();
const _laserPrev = new THREE.Vector3();
const _ramDelta = new THREE.Vector3();
const _pushDir = new THREE.Vector3();
// Deadzone on the yaw component of the frame's applied rotation before we
// accept a new bank sign — below this, sign(applied.y) is dominated by float
// noise and will flip ±MAX_BANK in a single frame (see updateFighterAI bank).
const BANK_SIGN_DEADZONE = 0.002;
const BANK_SMOOTH_RATE = 14; // exp smoothing toward target bank (1/seconds)

function randomDirection(): THREE.Vector3 {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  return new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));
}

/**
 * The conventional counterpart to Saucer Duel: same dodge-the-incoming-laser
 * decision logic, but a physically constrained fighter rather than a holonomic
 * disc. It jousts — attack runs toward the player while nose-guns are aligned,
 * then when it gets too close it flies past / extends away and only turns back
 * in once it has range again. It turns its nose toward wherever it wants to go
 * at a capped rate and always thrusts along its CURRENT heading, so — like the
 * player — reversing direction means actually turning around, not retargeting a
 * velocity vector instantly. The wedge shape (plus a cosmetic bank into turns)
 * makes that orientation readable at a glance, which the saucer's disc never could.
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

  // A 3-segment cylinder (not a full cone) makes a triangular-profile wedge
  // with a small but nonzero nose radius rather than a mathematically perfect
  // point — a true point presents literally zero cross-section when viewed
  // dead-on (nose pointed straight at the camera, which is exactly how it's
  // oriented while closing on the player), making it invisible from that
  // angle regardless of material brightness. Rotating -90° around X points
  // the narrow end down -Z (the same "forward" convention used everywhere
  // else) instead of the default +Y, and a non-uniform scale flattens it into
  // a dart/arrowhead rather than a tall pointy shape.
  const fighterBodyGeometry = new THREE.CylinderGeometry(0.15, 1, 1, 3);
  fighterBodyGeometry.rotateX(-Math.PI / 2);
  // A baseline emissive tint (not just a lighter diffuse color) so the
  // silhouette reads against the near-black background regardless of
  // lighting angle or distance from the point light — an unlit dark hull
  // would otherwise vanish into the fog well before it's in weapons range.
  const fighterBodyMaterial = new THREE.MeshStandardMaterial({
    color: "#8fa0c4",
    metalness: 0.4,
    roughness: 0.45,
    emissive: "#232d45",
    emissiveIntensity: 0.6,
    // Rendering both faces since the geometry's rotateX() call plausibly
    // inverts winding on the end caps relative to the lateral surface —
    // confirmed via testing: visible broadside, invisible viewed nose-on
    // (exactly the cap that would be backface-culled if so).
    side: THREE.DoubleSide,
  });
  // A bright centerline stripe from the nose back — an unambiguous visual
  // cue for "which way is forward" even at a glance or a low viewing angle.
  const fighterStripeGeometry = new THREE.BoxGeometry(0.4, 0.3, 1);
  const fighterStripeMaterial = new THREE.MeshStandardMaterial({
    color: "#ffcc66",
    emissive: "#8a5a00",
    emissiveIntensity: 0.9,
  });

  function buildFighterGroup(): THREE.Group {
    const group = new THREE.Group();
    const body = new THREE.Mesh(fighterBodyGeometry, fighterBodyMaterial);
    body.scale.set(FIGHTER_RADIUS * 1.1, FIGHTER_RADIUS * 0.4, FIGHTER_RADIUS * 1.6);
    group.add(body);
    // Mounted above the body's tallest cross-section (not buried inside the
    // cone's volume) so it reads as a spine along the top rather than
    // disappearing for most of the hull's length.
    const stripe = new THREE.Mesh(fighterStripeGeometry, fighterStripeMaterial);
    stripe.scale.set(1, 1, FIGHTER_RADIUS * 1.5);
    stripe.position.set(0, FIGHTER_RADIUS * 0.3, -FIGHTER_RADIUS * 0.1);
    group.add(stripe);
    return group;
  }

  const playerLaserGeometry = new THREE.CylinderGeometry(0.25, 0.25, 4, 6);
  const playerLaserMaterial = new THREE.MeshStandardMaterial({ color: "#8fe3a0", emissive: "#2f7a45", emissiveIntensity: 1.4 });
  const enemyLaserGeometry = new THREE.CylinderGeometry(0.25, 0.25, 4, 6);
  const enemyLaserMaterial = new THREE.MeshStandardMaterial({ color: "#ff8a3b", emissive: "#7a3b0f", emissiveIntensity: 1.4 });

  const rig = new FlightRig(canvas);
  rig.reset([0, 0, 0]);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const scanner = new ScannerHUD(150, 220);
  const hitFlash = new HitFlash();
  const fireZone = new FireZone(document.body);

  const playerLasers: Laser[] = [];
  const enemyLasers: Laser[] = [];
  let fighter: Fighter | null = null;
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
    // Last-frame visual orientation change (physics quat + cosmetic bank), in
    // degrees — useful for catching discontinuous jumps on-device without a
    // console. Sustained turns at the capped rate are ~1–3°/frame at 60fps;
    // pre-fix bank flicker was hitting ~80° in a single frame.
    rotJump: "0.0°",
  };

  function spawnFighter(): void {
    const position = rig.position
      .clone()
      .addScaledVector(randomDirection(), THREE.MathUtils.lerp(FIGHTER_SPAWN_MIN_DIST, FIGHTER_SPAWN_MAX_DIST, Math.random()));
    const group = buildFighterGroup();
    group.position.copy(position);
    scene.add(group);
    const toPlayer = rig.position.clone().sub(position).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), toPlayer);
    // Apply the spawn facing to the mesh immediately — otherwise the wedge
    // sits at identity for one frame before the first AI tick.
    group.quaternion.copy(quaternion);
    fighter = {
      group,
      position,
      quaternion,
      velocity: new THREE.Vector3(),
      maxSpeed: Math.min(FIGHTER_MAX_SPEED_CAP, FIGHTER_BASE_MAX_SPEED + kills * FIGHTER_SPEED_PER_KILL),
      turnRate: Math.min(FIGHTER_TURN_RATE_CAP, FIGHTER_TURN_RATE_DEG + kills * FIGHTER_TURN_PER_KILL),
      hp: FIGHTER_HP,
      fireCooldown: THREE.MathUtils.lerp(0.4, 1.0, Math.random()),
      phase: "attack",
      strafeSign: Math.random() < 0.5 ? 1 : -1,
      strafeTimer: 0,
      orbitAzimuth: Math.random() * Math.PI * 2,
      evadeDir: new THREE.Vector3(),
      evadeTimer: 0,
      bankAngle: 0,
      bankSign: 0,
    };
  }

  function fireEnemyLaser(from: Fighter): void {
    // Nose guns fire straight down the current heading (plus jitter), not at
    // the player's true position — the alignment gate at the call site is what
    // makes a shot land, so bolts always leave the nose, never sideways.
    const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(from.quaternion);
    const jitterAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    if (jitterAxis.lengthSq() < 1e-6) jitterAxis.set(0, 1, 0);
    jitterAxis.normalize();
    const jitterAngle = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(-FIGHTER_AIM_INACCURACY_DEG, FIGHTER_AIM_INACCURACY_DEG, Math.random()));
    aim.applyAxisAngle(jitterAxis, jitterAngle);
    const mesh = new THREE.Mesh(enemyLaserGeometry, enemyLaserMaterial);
    mesh.position.copy(from.position).addScaledVector(aim, FIGHTER_RADIUS + 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim);
    scene.add(mesh);
    enemyLasers.push({ mesh, velocity: aim.multiplyScalar(FIGHTER_LASER_SPEED), age: 0 });
  }

  function updateFighterAI(active: Fighter, delta: number): void {
    _toPlayer.subVectors(rig.position, active.position);
    const dist = _toPlayer.length();
    if (dist > 0.0001) _toPlayerDir.copy(_toPlayer).normalize();
    else _toPlayerDir.copy(FORWARD);
    // Nose for this frame — needed early for pass/extend steering (fly-past
    // vs reverse) before the turn step updates it.
    _forward.copy(FORWARD).applyQuaternion(active.quaternion);

    // Effective turn rate for this frame: the per-fighter (kill-scaled) rate,
    // boosted while jinking so an evade is a visibly sharper maneuver.
    const evadeBoost = active.evadeTimer > 0 ? FIGHTER_EVADE_TURN_MULT : 1;
    const turnRateDeg = active.turnRate * evadeBoost;

    if (active.evadeTimer <= 0) {
      for (const laser of playerLasers) {
        const speed2 = laser.velocity.lengthSq();
        if (speed2 < 1e-6) continue;
        _rel.subVectors(active.position, laser.mesh.position);
        const t = THREE.MathUtils.clamp(_rel.dot(laser.velocity) / speed2, 0, FIGHTER_EVADE_LOOKAHEAD);
        _closestPoint.copy(laser.mesh.position).addScaledVector(laser.velocity, t);
        if (_closestPoint.distanceTo(active.position) < FIGHTER_EVADE_RADIUS) {
          _lateral.crossVectors(laser.velocity, WORLD_Y);
          if (_lateral.lengthSq() < 1e-6) _lateral.crossVectors(laser.velocity, WORLD_X);
          _lateral.normalize();
          const side = _rel.subVectors(active.position, _closestPoint).dot(_lateral) < 0 ? -1 : 1;
          active.evadeDir.copy(_lateral).multiplyScalar(side);
          // Adaptive duration: turning from the current heading to the dodge
          // vector takes angle / rate seconds; a fixed 0.7s often expired
          // before the nose ever swung onto the dodge. Size the window to the
          // turn actually required (plus margin), capped so it can't loiter.
          const turnNeeded = _forward.angleTo(active.evadeDir);
          const boostedRateRad = THREE.MathUtils.degToRad(active.turnRate * FIGHTER_EVADE_TURN_MULT);
          active.evadeTimer = Math.min(FIGHTER_EVADE_MAX_DURATION, turnNeeded / boostedRateRad + 0.35);
          break;
        }
      }
    }

    if (active.evadeTimer > 0) {
      active.evadeTimer -= delta;
      _desiredDir.copy(active.evadeDir);
    } else {
      // Phase hysteresis: break off into an extend when the attack run gets
      // too close; only re-commit to a joust once we've opened enough range
      // to turn around without stalling next to the player.
      if (active.phase === "attack" && dist < FIGHTER_BREAK_RANGE) {
        active.phase = "extend";
      } else if (active.phase === "extend" && dist > FIGHTER_REENGAGE_RANGE) {
        active.phase = "attack";
        // Fresh pass plane / slip side for the next attack run.
        active.strafeSign = Math.random() < 0.5 ? 1 : -1;
        active.orbitAzimuth = Math.random() * Math.PI * 2;
        active.strafeTimer = THREE.MathUtils.lerp(1.2, 2.6, Math.random());
      }

      active.strafeTimer -= delta;
      if (active.strafeTimer <= 0) {
        active.strafeSign = Math.random() < 0.5 ? 1 : -1;
        active.strafeTimer = THREE.MathUtils.lerp(1.2, 2.6, Math.random());
        active.orbitAzimuth = Math.random() * Math.PI * 2;
      }

      if (active.phase === "extend") {
        // Still closing on this pass: keep flying forward (with a slip if
        // we're aimed too dead-on) so we complete the pass instead of trying
        // a 180° reverse while on top of the player. Once past, extend away.
        const closing = _forward.dot(_toPlayerDir);
        if (closing > 0.15) {
          _desiredDir.copy(_forward);
          if (closing > 0.92) {
            // Near collision course — nudge onto a slip so the pass clears
            // the player's hull rather than ramming through.
            _right.crossVectors(_toPlayerDir, WORLD_Y);
            if (_right.lengthSq() < 1e-6) _right.crossVectors(_toPlayerDir, WORLD_X);
            _right.normalize();
            _axis.crossVectors(_right, _toPlayerDir).normalize();
            _axis.applyAxisAngle(_toPlayerDir, active.orbitAzimuth);
            _desiredDir.addScaledVector(_axis, 0.45 * active.strafeSign).normalize();
          }
        } else {
          _desiredDir.copy(_toPlayerDir).multiplyScalar(-1);
        }
      } else {
        // Attack run: point the nose at a laser-speed intercept of the
        // player so bolts down the nose actually arrive where they'll be —
        // not a fixed lead angle off pure pursuit (that systematically missed
        // once joust range got long).
        const flightTime = dist / FIGHTER_LASER_SPEED;
        _intercept.copy(rig.position).addScaledVector(rig.velocity, flightTime).sub(active.position);
        if (_intercept.lengthSq() > 1e-8) _desiredDir.copy(_intercept).normalize();
        else _desiredDir.copy(_toPlayerDir);
      }
    }

    // Turn toward the desired heading at a bounded rate — this (not an
    // instant velocity flip) is what makes it read as a real craft.
    //
    // Target orientation is built by rotating the CURRENT attitude so its
    // nose swings onto desiredDir (twist-minimizing), NOT by
    // setFromUnitVectors(FORWARD, desiredDir) from identity. The identity
    // construction picks an arbitrary roll around the nose; as desiredDir
    // sweeps (especially through the antipode of FORWARD when backing off)
    // that implied roll flips discontinuously, and rotateTowards then burns
    // its whole turn budget on a sudden roll snap. Composing a delta from
    // the live forward preserves the current roll and only asks for the
    // heading change we actually want.
    _prevQuat.copy(active.quaternion);
    _prevForward.copy(FORWARD).applyQuaternion(active.quaternion);
    const align = _prevForward.dot(_desiredDir);
    if (align > 0.999999) {
      _targetQuat.copy(active.quaternion);
    } else if (align < -0.999999) {
      // Exactly antipodal: setFromUnitVectors' axis is undefined and flips
      // every frame under tiny noise. Pin the 180° flip to the craft's
      // current local up (fall back to local right if up ≈ forward).
      _axis.set(0, 1, 0).applyQuaternion(active.quaternion);
      if (Math.abs(_axis.dot(_prevForward)) > 0.95) {
        _axis.set(1, 0, 0).applyQuaternion(active.quaternion);
      }
      _axis.normalize();
      _targetQuat.setFromAxisAngle(_axis, Math.PI).multiply(active.quaternion);
    } else {
      _deltaQuat.setFromUnitVectors(_prevForward, _desiredDir);
      _targetQuat.copy(_deltaQuat).multiply(active.quaternion);
    }
    // Quaternion double-cover: keep the short-arc representative so
    // rotateTowards doesn't take the long way around.
    if (active.quaternion.dot(_targetQuat) < 0) {
      _targetQuat.x = -_targetQuat.x;
      _targetQuat.y = -_targetQuat.y;
      _targetQuat.z = -_targetQuat.z;
      _targetQuat.w = -_targetQuat.w;
    }
    const maxStep = THREE.MathUtils.degToRad(turnRateDeg) * delta;
    active.quaternion.rotateTowards(_targetQuat, maxStep);
    _forward.copy(FORWARD).applyQuaternion(active.quaternion);
    const turnedAngle = _prevForward.angleTo(_forward);

    // Thrust is always along the CURRENT nose direction, never the desired
    // one — reversing course means actually turning around first. Brake hard
    // when badly misaligned so an attack run doesn't skate sideways; during
    // an extend, keep a higher floor so the post-pass turnaround still covers
    // ground instead of taxiing in place.
    const dot = _forward.dot(_desiredDir);
    let speedScale = dot >= 0 ? THREE.MathUtils.lerp(0.4, 1, dot) : THREE.MathUtils.lerp(0.4, 0.06, -dot);
    if (active.phase === "extend" && active.evadeTimer <= 0) {
      speedScale = Math.max(speedScale, 0.45);
    }
    _targetVelocity.copy(_forward).multiplyScalar(active.maxSpeed * speedScale);
    active.velocity.lerp(_targetVelocity, 1 - Math.pow(0.001, delta));
    active.position.addScaledVector(active.velocity, delta);
    active.group.position.copy(active.position);

    // Purely cosmetic roll into the turn. Two things used to make this look
    // like an instant orientation jump even when the physics quat was fine:
    //
    // 1. bankSign = sign(appliedRotation.y) with no deadzone — near zero the
    //    sign flips on float noise every other frame.
    // 2. bankFraction saturates to 1 whenever the craft is turning at its
    //    capped rate (the normal case), so a sign flip slammed the mesh
    //    between +MAX_BANK and -MAX_BANK (~84°) in a single frame.
    //
    // Hysteresis on the sign + exponential smoothing on the angle keeps the
    // bank readable without discontinuous snaps. Target bank goes to 0 when
    // we aren't actually turning.
    _prevGroupQuat.copy(active.group.quaternion);
    _appliedRotation.copy(_prevQuat).invert().multiply(active.quaternion);
    if (_appliedRotation.y > BANK_SIGN_DEADZONE) active.bankSign = 1;
    else if (_appliedRotation.y < -BANK_SIGN_DEADZONE) active.bankSign = -1;
    const turnRateNow = delta > 0 ? turnedAngle / delta : 0;
    const bankFraction = THREE.MathUtils.clamp(turnRateNow / THREE.MathUtils.degToRad(active.turnRate), 0, 1);
    const targetBank =
      turnedAngle < 1e-5 ? 0 : bankFraction * THREE.MathUtils.degToRad(FIGHTER_MAX_BANK_DEG) * active.bankSign;
    const bankBlend = 1 - Math.exp(-delta * BANK_SMOOTH_RATE);
    active.bankAngle += (targetBank - active.bankAngle) * bankBlend;
    _bankQuat.setFromAxisAngle(ROLL_AXIS, active.bankAngle);
    active.group.quaternion.copy(active.quaternion).multiply(_bankQuat);

    // Surface the visual Δ so on-device play can confirm jumps are gone
    // without digging through a console (see readout.rotJump).
    const visualJumpDeg = THREE.MathUtils.radToDeg(_prevGroupQuat.angleTo(active.group.quaternion));
    readout.rotJump = `${visualJumpDeg.toFixed(1)}°`;

    if (active.fireCooldown > 0) active.fireCooldown -= delta;
    const alignMin = dist >= FIGHTER_FIRE_TIGHT_RANGE ? FIGHTER_FIRE_ALIGNMENT_TIGHT : FIGHTER_FIRE_ALIGNMENT_MIN;
    // Align against the same intercept the nose is chasing (not raw toPlayer),
    // otherwise a correct lead shot fails the gate while chasing a mover.
    const flightTime = dist / FIGHTER_LASER_SPEED;
    _intercept.copy(rig.position).addScaledVector(rig.velocity, flightTime).sub(active.position);
    if (_intercept.lengthSq() > 1e-8) _intercept.normalize();
    else _intercept.copy(_toPlayerDir);
    if (active.fireCooldown <= 0 && dist <= FIGHTER_FIRE_RANGE && active.evadeTimer <= 0 && _forward.dot(_intercept) >= alignMin) {
      fireEnemyLaser(active);
      const minCd = Math.max(FIGHTER_FIRE_COOLDOWN_FLOOR, FIGHTER_FIRE_COOLDOWN_MIN_BASE - kills * FIGHTER_FIRE_COOLDOWN_SHRINK_PER_KILL);
      const maxCd = Math.max(minCd + 0.2, FIGHTER_FIRE_COOLDOWN_MAX_BASE - kills * FIGHTER_FIRE_COOLDOWN_SHRINK_PER_KILL);
      active.fireCooldown = THREE.MathUtils.lerp(minCd, maxCd, Math.random());
    }
  }

  function damageFighter(active: Fighter): void {
    active.hp -= 1;
    score += FIGHTER_SCORE_PER_HIT;
    readout.score = score;
    hitGlow = 1;
    if (active.hp <= 0) {
      kills += 1;
      score += FIGHTER_KILL_BONUS;
      readout.score = score;
      readout.kills = kills;
      scene.remove(active.group);
      fighter = null;
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

  // Takes a push direction (must be normalized) rather than the laser, so
  // ship-ship rams can reuse the exact same knockback with fighter→player.
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
    if (fighter) scene.remove(fighter.group);
    fighter = null;
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
  gui.add(readout, "rotJump").name("Rot jump (frame)").listen().disable();
  gui.add({ restart }, "restart").name("Restart");

  return {
    manualCamera: true,
    update(delta) {
      if (state !== "countdown") rig.update(delta);
      if (fireCooldown > 0) fireCooldown -= delta;
      if (invulnerable > 0) invulnerable -= delta;
      if (hitGlow > 0) hitGlow = Math.max(0, hitGlow - delta * FIGHTER_HIT_GLOW_DECAY);
      fighterStripeMaterial.emissiveIntensity = 0.7 + hitGlow * 2.2;
      if (fireZone.autoFire || fireZone.held) firePlayerLaser();

      if (state === "countdown") {
        countdownRemaining -= delta;
        if (countdownRemaining > 0) {
          readout.status = `${Math.ceil(countdownRemaining)}…`;
        } else {
          state = "playing";
          readout.status = "Fly & Fire";
          spawnFighter();
        }
      }

      if (state === "playing") {
        for (let i = playerLasers.length - 1; i >= 0; i--) {
          const laser = playerLasers[i];
          _laserPrev.copy(laser.mesh.position);
          laser.mesh.position.addScaledVector(laser.velocity, delta);
          laser.age += delta;
          if (laser.age > LASER_LIFETIME) {
            scene.remove(laser.mesh);
            playerLasers.splice(i, 1);
            continue;
          }
          // Swept test over the segment travelled this frame — a point sample
          // at the new position tunnels through the target on slow frames.
          if (fighter && segmentHitsSphere(_laserPrev, laser.mesh.position, fighter.position, FIGHTER_RADIUS)) {
            scene.remove(laser.mesh);
            playerLasers.splice(i, 1);
            damageFighter(fighter);
          }
        }

        for (let i = enemyLasers.length - 1; i >= 0; i--) {
          const laser = enemyLasers[i];
          _laserPrev.copy(laser.mesh.position);
          laser.mesh.position.addScaledVector(laser.velocity, delta);
          laser.age += delta;
          if (laser.age > FIGHTER_LASER_LIFETIME) {
            scene.remove(laser.mesh);
            enemyLasers.splice(i, 1);
            continue;
          }
          if (invulnerable <= 0 && segmentHitsSphere(_laserPrev, laser.mesh.position, rig.position, SHIP_RADIUS + 1.2)) {
            scene.remove(laser.mesh);
            enemyLasers.splice(i, 1);
            loseLife(_pushDir.copy(laser.velocity).normalize());
          }
        }

        if (fighter) {
          updateFighterAI(fighter, delta);
        } else {
          respawnTimer -= delta;
          if (respawnTimer <= 0) spawnFighter();
        }

        // Ramming costs both sides: the player pays a life (same knockback as
        // a hit, pushed away from the fighter) and the fighter takes damage.
        // The player's invuln window gates re-triggering so a graze isn't
        // instantly fatal.
        if (fighter && invulnerable <= 0) {
          _ramDelta.subVectors(rig.position, fighter.position);
          const contact = FIGHTER_RADIUS + SHIP_RADIUS;
          if (_ramDelta.lengthSq() < contact * contact) {
            if (_ramDelta.lengthSq() > 1e-8) _pushDir.copy(_ramDelta).normalize();
            else _pushDir.set(0, 0, 1);
            loseLife(_pushDir);
            damageFighter(fighter);
          }
        }
      }

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      scanner.update(rig.position, rig.quaternion, fighter ? [{ label: "fighter", color: "#ff8a3b", position: fighter.position }] : []);
    },
    dispose() {
      rig.dispose();
      scanner.dispose();
      hitFlash.dispose();
      fireZone.dispose();

      fighterBodyGeometry.dispose();
      fighterBodyMaterial.dispose();
      fighterStripeGeometry.dispose();
      fighterStripeMaterial.dispose();
      playerLaserGeometry.dispose();
      playerLaserMaterial.dispose();
      enemyLaserGeometry.dispose();
      enemyLaserMaterial.dispose();
      if (fighter) scene.remove(fighter.group);
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

export const wedgeDuelScene: TestScene = {
  id: "wedge-duel",
  name: "Course: Wedge Duel",
  description: "One-on-one dogfight against a conventional fighter — jousting passes, orientation-locked, banks into turns, nose-mounted guns.",
  setup,
};
