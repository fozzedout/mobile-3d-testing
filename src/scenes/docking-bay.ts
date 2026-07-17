import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { ScannerHUD } from "../core/scanner-hud.ts";
import { LandingHUD } from "../core/landing-hud.ts";
import { TargetPointer } from "../core/target-pointer.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { CourseTimer } from "../core/course-timer.ts";
import { HitFlash } from "../core/hit-flash.ts";
import { buildStarfield } from "../core/starfield.ts";

// One voxel cell = this many world units. Cells are addressed by integer
// coords in STATION-LOCAL space; a cell's centre is cell*VOXEL, its AABB is
// centre ± VOXEL/2. The occupancy Set built from these coords is BOTH the
// rendered shell and the collider, so the visual and the collision geometry
// can never drift apart.
const VOXEL = 10;
const HALF = VOXEL / 2;

const SPIN = 0.15; // rad/s about the station's local +Z axis (spin-gravity drum)
const SHIP_RADIUS = 2.2;
const HIT_PENALTY_MS = 2000;
const INVULN_SECONDS = 1.2; // cooldown so one scrape isn't billed as ten penalties
const SPAWN: THREE.Vector3Tuple = [0, 0, 160];

// Station extents in cells. Solid box x,y ∈ [-4..4], z ∈ [-3..3] minus a hollow
// cavity x,y,z ∈ [-2..2]. The +Z wall (z = 3) is one cell thick, so punching a
// row out of it opens a tunnel straight into the cavity.
const BOX_XY = 4;
const BOX_Z = 3;
const CAV = 2;

// Landing pad sits on the cavity floor: the top faces of the wall cells at
// y = -3, x ∈ [0..1], z ∈ [-1..0]. That surface is one ship-radius below where
// a docked ship's centre rests. Pad centre (local): x = 0.5, z = -0.5 cells.
const PAD_SURFACE_Y = -(CAV + 1) * VOXEL + HALF; // top face of the y = -3 cells = -25
const PAD_X_MIN = -HALF; // pad footprint spans cells x 0..1 → world [-5, 15]
const PAD_X_MAX = VOXEL + HALF;
const PAD_Z_MIN = -(VOXEL + HALF); // cells z -1..0 → world [-15, 5]
const PAD_Z_MAX = HALF;
const PAD_CEIL = PAD_SURFACE_Y + SHIP_RADIUS + 2; // must be hovering low over the pad
const PAD_FLOOR = PAD_SURFACE_Y - 0.5;
const LAND_SPEED = 4; // relative to the (rotating) pad, u/s
const HOLD_SECONDS = 1.5; // touchdown hold before the dock counts

// Aim points, station-local. Both are transformed by the station's live
// orientation each frame, so the scanner tracks them as the drum turns. The
// slot centre lies on the +Z outer face; the pad centre on the cavity floor.
const SLOT_LOCAL = new THREE.Vector3(0, 0, (BOX_Z + 0.5) * VOXEL); // (0,0,35)
const PAD_LOCAL = new THREE.Vector3(HALF, PAD_SURFACE_Y, -HALF); // (5,-25,-5)

// Magnetic capture field over the pad. Real-device feedback: settling onto a
// tight window blind (no read on whether the pad is above or below you) was
// fiddly, so a slow, hands-off ship is instead caught by a soft funnel that
// draws it to the seat and rights it — thrust always overrides the magnet.
// SEAT_LOCAL is the ship-centre rest point over the pad centre (station-local).
// Capture target: ship-centre rest point over the pad centre. The 0.6 clearance
// keeps the whole snap window (SNAP_DIST) plus servo jitter above the pad
// cells' collision threshold (SHIP_RADIUS off the surface), so the field can
// never scrape you across your own landing pad while it reels you in.
const SEAT_LOCAL = new THREE.Vector3(PAD_LOCAL.x, PAD_SURFACE_Y + SHIP_RADIUS + 0.6, PAD_LOCAL.z);
const CAPTURE_RADIUS = 12;     // field reach from the seat point, world units
const CAPTURE_SPEED = 8;       // max relative speed at which the field can grab
const CAPTURE_PULL = 1;        // reel speed per unit of seat offset, 1/s
const CAPTURE_REEL = 5;        // cap on the commanded approach speed, u/s
const CAPTURE_GAIN = 3;        // how hard the field steers velocity onto the command, 1/s
const CAPTURE_MAX_ACCEL = 15;  // clamp on field acceleration, u/s²
const CAPTURE_ALIGN_RATE = 0.9; // rad/s — how fast the field rights the ship
const SNAP_DIST = 0.7;         // within this of the seat...
const SNAP_SPEED = 0.8;        // ...and this slow (relative) → clamps engage

const CAVITY_HALF = (CAV + 0.5) * VOXEL; // 25 — cavity interior half-extent
const OUTER_CLEAR_XY = (BOX_XY + 1.5) * VOXEL; // 55 — well past the outer shell
const OUTER_CLEAR_Z = (BOX_Z + 1.5) * VOXEL; // 45

type Phase = "approach" | "land" | "depart" | "exit";
const PHASE_LABEL: Record<Phase, string> = {
  approach: "Approach",
  land: "Land",
  depart: "Depart",
  exit: "Exit",
};

// Per-frame scratch — the update path runs every frame on phones, so station
// interaction is kept allocation-free (reused in place via .copy()/.set()).
// update() is never re-entrant, so module-scope sharing is safe. The station
// only rotates about a fixed axis through the origin, so world<->local is a
// pure quaternion rotation: local = worldPos·q⁻¹, and a local vector back to
// world is v·q. That's cheaper (and clearer) than inverting a full matrix.
const _invQuat = new THREE.Quaternion();
const _local = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _padVel = new THREE.Vector3();
const _relVel = new THREE.Vector3(); // reused: world relVel, then rotated into station-local for the HUD
const _bestNormal = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();
const _targetWorld = new THREE.Vector3();
const _frameQuat = new THREE.Quaternion(); // per-frame drum delta, used to co-rotate the docked view
const _spinAxis = new THREE.Vector3(0, 0, 1); // world +Z: the station's only rotation axis (never mutated)
const _capOffset = new THREE.Vector3(); // SEAT_LOCAL − ship, station-local (its length is the world distance to the seat)
const _seatWorld = new THREE.Vector3(); // SEAT_LOCAL carried into world by the drum's orientation
const _padWorld = new THREE.Vector3(); // PAD_LOCAL carried into world, for the screen-space pointer
const _capAccel = new THREE.Vector3(); // field spring-damper acceleration (world)
const _shipUp = new THREE.Vector3(); // ship-local +Y in world
const _padUp = new THREE.Vector3(); // pad (station-local) +Y in world
const _alignQuat = new THREE.Quaternion(); // shortest arc ship-up → pad-up
const _stepQuat = new THREE.Quaternion(); // that arc rate-limited to CAPTURE_ALIGN_RATE·delta

function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** Timed course: dock at a spinning voxel station — thread the rotating slot, land on the pad, take off and exit clean. */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = new THREE.Fog("#04060c", 140, 520);
  scene.background = new THREE.Color("#04060c");
  camera.far = 550; // must reach the station (~125u away) from spawn with margin
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(360, 520, 2400);
  scene.add(stars);
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2, 120);
  scene.add(shipLight);

  // --- Build the voxel shell. Occupancy is the collider; the InstancedMesh is
  // just its visualisation, so a cell is drawn iff it's in the Set. ---
  const occupancy = new Set<string>();
  for (let x = -BOX_XY; x <= BOX_XY; x++) {
    for (let y = -BOX_XY; y <= BOX_XY; y++) {
      for (let z = -BOX_Z; z <= BOX_Z; z++) {
        const inCavity = Math.abs(x) <= CAV && Math.abs(y) <= CAV && Math.abs(z) <= CAV;
        if (!inCavity) occupancy.add(cellKey(x, y, z));
      }
    }
  }
  // Entrance: a 3-wide × 1-tall mail slot punched through the +Z wall. It
  // rotates WITH the station (it's just three missing cells) — that's the
  // challenge, classic Elite: you match the drum's spin to fly the slot.
  const slotCells: THREE.Vector3Tuple[] = [
    [-1, 0, BOX_Z],
    [0, 0, BOX_Z],
    [1, 0, BOX_Z],
  ];
  for (const [x, y, z] of slotCells) occupancy.delete(cellKey(x, y, z));

  const stationGroup = new THREE.Group();
  scene.add(stationGroup);

  // Only cells with at least one free neighbor get an instance — fully buried
  // cells (the meat inside the 2-cell-thick walls) can never be seen, and this
  // is a fill-rate-sensitive full-screen mesh on approach. The occupancy Set
  // itself stays complete: it is the collider and must not thin out.
  const cells: THREE.Vector3Tuple[] = [];
  for (const key of occupancy) {
    const [x, y, z] = key.split(",").map(Number);
    const buried =
      occupancy.has(cellKey(x + 1, y, z)) && occupancy.has(cellKey(x - 1, y, z)) &&
      occupancy.has(cellKey(x, y + 1, z)) && occupancy.has(cellKey(x, y - 1, z)) &&
      occupancy.has(cellKey(x, y, z + 1)) && occupancy.has(cellKey(x, y, z - 1));
    if (!buried) cells.push([x, y, z]);
  }

  const voxelGeometry = new THREE.BoxGeometry(VOXEL * 0.98, VOXEL * 0.98, VOXEL * 0.98);
  const voxelMaterial = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.1, flatShading: true });
  const voxels = new THREE.InstancedMesh(voxelGeometry, voxelMaterial, cells.length);
  const baseColor = new THREE.Color("#6a7284");
  const buildMatrix = new THREE.Matrix4();
  const instanceColor = new THREE.Color();
  cells.forEach((cell, i) => {
    buildMatrix.makeTranslation(cell[0] * VOXEL, cell[1] * VOXEL, cell[2] * VOXEL);
    voxels.setMatrixAt(i, buildMatrix);
    // ±10% brightness jitter so the shell reads as panelling rather than a solid mass.
    instanceColor.copy(baseColor).multiplyScalar(0.9 + Math.random() * 0.2);
    voxels.setColorAt(i, instanceColor);
  });
  voxels.instanceMatrix.needsUpdate = true;
  if (voxels.instanceColor) voxels.instanceColor.needsUpdate = true;
  stationGroup.add(voxels);

  // Landing pad — thin emissive-green slab inset onto the cavity floor. A child
  // of stationGroup, so it visibly rotates with the drum.
  const padGeometry = new THREE.BoxGeometry(VOXEL * 1.9, 0.6, VOXEL * 1.9);
  const padMaterial = new THREE.MeshStandardMaterial({ color: "#0a3d1f", emissive: "#22c55e", emissiveIntensity: 0.9 });
  const pad = new THREE.Mesh(padGeometry, padMaterial);
  pad.position.set(PAD_LOCAL.x, PAD_SURFACE_Y + 0.4, PAD_LOCAL.z);
  stationGroup.add(pad);

  // Touchdown projection marker — a flat emissive ring lying just above the pad
  // plane, parented to stationGroup so it rotates with the drum. Each frame it's
  // moved under the ship's local x/z (clamped to the cavity so it never sinks
  // into a wall) to answer "where would I set down right now". Shown only while
  // landing/departing and inside the cavity.
  const markerGeometry = new THREE.RingGeometry(1.8, 2.5, 24);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: "#22c55e", transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial);
  marker.rotation.x = -Math.PI / 2; // RingGeometry is XY by default; lay it flat on the XZ pad plane
  marker.visible = false;
  stationGroup.add(marker);

  // Magnetic capture volume — a faint open green column standing over the pad,
  // parented to stationGroup so it spins with the drum. It marks the reach of
  // the field; it brightens and pulses while the field actually has the ship.
  const captureColumnGeometry = new THREE.CylinderGeometry(CAPTURE_RADIUS, CAPTURE_RADIUS, CAPTURE_RADIUS * 1.6, 24, 1, true);
  const captureColumnMaterial = new THREE.MeshBasicMaterial({
    color: "#22c55e",
    transparent: true,
    opacity: 0.06,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const captureColumn = new THREE.Mesh(captureColumnGeometry, captureColumnMaterial);
  captureColumn.position.set(PAD_LOCAL.x, PAD_SURFACE_Y + CAPTURE_RADIUS * 0.8, PAD_LOCAL.z);
  captureColumn.visible = false;
  stationGroup.add(captureColumn);

  // Two light strips framing the slot on the outer +Z face (green left / red
  // right), so the slot's rotation is legible from the approach distance.
  const stripGeometry = new THREE.BoxGeometry(2, VOXEL, 2);
  const greenStripMat = new THREE.MeshStandardMaterial({ color: "#0a3d1f", emissive: "#22c55e", emissiveIntensity: 1.1 });
  const redStripMat = new THREE.MeshStandardMaterial({ color: "#3d0a0a", emissive: "#ef4444", emissiveIntensity: 1.1 });
  const greenStrip = new THREE.Mesh(stripGeometry, greenStripMat);
  greenStrip.position.set(-17, 0, (BOX_Z + 0.5) * VOXEL + 1);
  const redStrip = new THREE.Mesh(stripGeometry, redStripMat);
  redStrip.position.set(17, 0, (BOX_Z + 0.5) * VOXEL + 1);
  stationGroup.add(greenStrip, redStrip);

  // Runway-style glow frame hugging the slot opening itself — the side strips
  // signal WHERE the slot region is, but the dark 30x10 hole against a dark
  // wall was unreadable at approach range; the mouth needs its own outline.
  const slotFrameMat = new THREE.MeshStandardMaterial({ color: "#0a2a3d", emissive: "#7dd3fc", emissiveIntensity: 1.2 });
  const slotFrameZ = (BOX_Z + 0.5) * VOXEL + 0.6;
  const slotBarGeometry = new THREE.BoxGeometry(3 * VOXEL + 2, 1.2, 1.2);
  const slotPostGeometry = new THREE.BoxGeometry(1.2, VOXEL + 2, 1.2);
  const slotTop = new THREE.Mesh(slotBarGeometry, slotFrameMat);
  slotTop.position.set(0, VOXEL / 2 + 0.6, slotFrameZ);
  const slotBottom = new THREE.Mesh(slotBarGeometry, slotFrameMat);
  slotBottom.position.set(0, -VOXEL / 2 - 0.6, slotFrameZ);
  const slotLeft = new THREE.Mesh(slotPostGeometry, slotFrameMat);
  slotLeft.position.set(-1.5 * VOXEL - 0.6, 0, slotFrameZ);
  const slotRight = new THREE.Mesh(slotPostGeometry, slotFrameMat);
  slotRight.position.set(1.5 * VOXEL + 0.6, 0, slotFrameZ);
  stationGroup.add(slotTop, slotBottom, slotLeft, slotRight);

  // Dim interior light parented inside the drum so the bay isn't a black hole.
  const bayLight = new THREE.PointLight(0x88bbff, 1.4, 130);
  bayLight.position.set(0, 0, 0);
  stationGroup.add(bayLight);

  const rig = new FlightRig(canvas);
  rig.reset(SPAWN);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const scanner = new ScannerHUD(150, 240);
  const landingHud = new LandingHUD();
  const pointer = new TargetPointer();
  const timer = new CourseTimer({ storageKey: "course-best:docking-bay" });
  const hitFlash = new HitFlash();

  let phase: Phase = "approach";
  let landHold = 0;
  let invulnerable = 0;
  let elapsed = 0; // running clock, only for the capture column's pulse
  // Field has hold of a slow, hands-off ship and is drawing it to the seat, but
  // the clamps haven't engaged yet — a soft, breakable state before `attached`.
  let capturing = false;
  // Docking clamp: while attached the ship is welded into the rotating station
  // frame. seatLocal is its fixed station-LOCAL resting point, captured once at
  // touchdown; the world pose is regenerated from it each frame, so the ship
  // cannot drift off the pad however long it stays docked.
  let attached = false;
  const seatLocal = new THREE.Vector3();
  const phaseReadout = { phase: PHASE_LABEL.approach };

  function restart(): void {
    rig.reset(SPAWN);
    // Zero the drum's orientation so every attempt sees the same slot phase at
    // "Go!" — otherwise best times wouldn't be comparable run to run.
    stationGroup.rotation.z = 0;
    phase = "approach";
    phaseReadout.phase = PHASE_LABEL.approach;
    landHold = 0;
    invulnerable = 0;
    attached = false;
    capturing = false;
    rig.assistBrake = true;
    seatLocal.set(0, 0, 0);
    captureColumn.visible = false;
    pointer.setVisible(false);
    timer.restart();
  }

  rig.registerControls(gui);
  gui.add(timer, "statusText").name("Status").listen().disable();
  gui.add(timer, "timeText").name("Time").listen().disable();
  gui.add(timer, "bestText").name("Best").listen().disable();
  gui.add(timer, "hits").name("Hits").listen().disable();
  gui.add(phaseReadout, "phase").name("Phase").listen().disable();
  gui.add({ restart }, "restart").name("Restart");

  function applyHit(localNormal: THREE.Vector3, penetration: number): void {
    if (invulnerable > 0) return;
    timer.addPenalty(HIT_PENALTY_MS);
    invulnerable = INVULN_SECONDS;
    hitFlash.trigger();
    // Push out along the local-space penetration normal, rotated back to world.
    const worldNormal = _worldNormal.copy(localNormal).applyQuaternion(stationGroup.quaternion).normalize();
    rig.position.addScaledVector(worldNormal, penetration + 0.5);
    const into = rig.velocity.dot(worldNormal);
    if (into < 0) rig.velocity.addScaledVector(worldNormal, -into); // kill velocity into the wall
  }

  // Collision test in STATION-LOCAL space: round the ship to its cell, then
  // test the 3×3×3 neighbourhood. For each occupied neighbour, take the point-
  // vs-AABB closest point and its distance; if the deepest overlap breaks
  // SHIP_RADIUS, that neighbour's outward normal drives the push-out.
  function checkCollisions(): void {
    if (invulnerable > 0) return;
    const cx = Math.round(_local.x / VOXEL);
    const cy = Math.round(_local.y / VOXEL);
    const cz = Math.round(_local.z / VOXEL);
    let bestPen = -Infinity;
    let found = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          if (!occupancy.has(cellKey(x, y, z))) continue;
          const ccx = x * VOXEL;
          const ccy = y * VOXEL;
          const ccz = z * VOXEL;
          const clx = THREE.MathUtils.clamp(_local.x, ccx - HALF, ccx + HALF);
          const cly = THREE.MathUtils.clamp(_local.y, ccy - HALF, ccy + HALF);
          const clz = THREE.MathUtils.clamp(_local.z, ccz - HALF, ccz + HALF);
          let nx = _local.x - clx;
          let ny = _local.y - cly;
          let nz = _local.z - clz;
          const d2 = nx * nx + ny * ny + nz * nz;
          if (d2 >= SHIP_RADIUS * SHIP_RADIUS) continue;
          let pen: number;
          if (d2 > 1e-4) {
            const d = Math.sqrt(d2);
            pen = SHIP_RADIUS - d;
            nx /= d;
            ny /= d;
            nz /= d;
          } else {
            // Ship centre buried inside a solid cell (deep overlap): escape
            // through the nearest face rather than a degenerate zero normal.
            const ox = _local.x - ccx;
            const oy = _local.y - ccy;
            const oz = _local.z - ccz;
            const ax = Math.abs(ox);
            const ay = Math.abs(oy);
            const az = Math.abs(oz);
            nx = ny = nz = 0;
            if (ax >= ay && ax >= az) nx = Math.sign(ox) || 1;
            else if (ay >= az) ny = Math.sign(oy) || 1;
            else nz = Math.sign(oz) || 1;
            pen = SHIP_RADIUS;
          }
          if (pen > bestPen) {
            bestPen = pen;
            _bestNormal.set(nx, ny, nz);
            found = true;
          }
        }
      }
    }
    if (found) applyHit(_bestNormal, bestPen);
  }

  return {
    manualCamera: true,
    update(delta) {
      if (timer.state !== "countdown") rig.update(delta);
      timer.update(delta);
      elapsed += delta;
      if (invulnerable > 0) invulnerable -= delta;

      // The drum spins continuously — during the countdown too, so the slot is
      // already moving when racing starts.
      stationGroup.rotation.z += SPIN * delta;

      // Docked: sweep the ship with the drum. The drum orientation was just
      // advanced above, so regenerating the world pose from the stored local
      // seat keeps the ship locked to the pad with zero drift accumulation.
      // The view co-rotates by the same frame delta (world +Z) so the bay looks
      // stationary while the stars wheel past the slot — the frame switch made
      // visible — with the player's own look (rig.update, already applied) on
      // top. Velocity is slaved to the pad point's ω × r so the HUD drift reads
      // exactly 0 and a later release inherits the right tangential velocity.
      if (attached) {
        rig.position.copy(seatLocal).applyQuaternion(stationGroup.quaternion);
        _frameQuat.setFromAxisAngle(_spinAxis, SPIN * delta);
        rig.quaternion.premultiply(_frameQuat);
        rig.velocity.set(-SPIN * rig.position.y, SPIN * rig.position.x, 0);
      }

      // World -> station-local for this frame (pure inverse rotation).
      _invQuat.copy(stationGroup.quaternion).invert();
      _local.copy(rig.position).applyQuaternion(_invQuat);

      const insideCavity =
        Math.abs(_local.x) < CAVITY_HALF && Math.abs(_local.y) < CAVITY_HALF && Math.abs(_local.z) < CAVITY_HALF;

      if (timer.state === "racing") {
        // Release the clamp on deliberate translational input. Velocity is
        // already the pad's tangential velocity (slaved above), so the ship
        // simply keeps drifting with the rotation it was part of — no special
        // casing — until the player flies it out; normal physics resume below.
        if (attached && rig.translationInput > 0.3) attached = false;

        // Seated ship: the stored seat is authoritative, so collision penalties
        // and spin-gravity are skipped while attached. While merely `capturing`
        // (not yet clamped) both stay ACTIVE — the field has to overpower
        // spin-gravity, which it comfortably does: ω²r ≈ 0.15²·25 ≈ 0.6 u/s²,
        // while the field's pull is clamped at 10 u/s² and near the seat the
        // damping term pins the relative velocity, so 0.6 « 10 and the field wins.
        if (!attached) {
          checkCollisions();

          // Spin-gravity: centripetal pseudo-gravity while inside the cavity,
          // pointing AWAY from the spin axis (station local +Z). The outward
          // unit vector is (x,y,0)/r and the magnitude is SPIN²·r, so in local
          // coords the acceleration is simply SPIN²·(x, y, 0). Coriolis is
          // deliberately omitted — a coarse approximation is plenty for a
          // testbed. This presses a ship hovering over the pad (out at local
          // -y) toward it.
          if (insideCavity) {
            _accel.set(_local.x, _local.y, 0).multiplyScalar(SPIN * SPIN);
            _accel.applyQuaternion(stationGroup.quaternion); // local -> world
            rig.velocity.addScaledVector(_accel, delta);
          }
        }

        // Relative velocity vs the rotating pad drives both the capture field and
        // the HUD. The pad point's world velocity is ω × r, with ω = the
        // station's angular velocity (about world +Z, since spinning about Z
        // leaves the Z axis fixed) and r the ship's offset from the axis:
        // (0,0,SPIN) × (x,y,0) = (-SPIN·y, SPIN·x, 0). _relVel holds the world
        // relative velocity (ship − pad) through the switch; the showLanding
        // block re-derives it into station-local afterwards.
        _padVel.set(-SPIN * rig.position.y, SPIN * rig.position.x, 0);
        const relSpeed = _relVel.copy(rig.velocity).sub(_padVel).length();
        // Distance to the seat, station-local (rotation preserves length, so this
        // is also the world distance).
        const seatDist = _capOffset.copy(SEAT_LOCAL).sub(_local).length();

        switch (phase) {
          case "approach":
            timer.statusText = "Approach — thread the rotating slot";
            if (insideCavity) phase = "land";
            break;
          case "land":
            if (!attached) {
              // The field grabs a slow, hands-off ship inside its reach and lets
              // go the instant thrust exceeds the deadband (the same gate that
              // releases the clamps, so magnet and pilot never fight) or the ship
              // is dragged/flies well outside the reach.
              if (capturing) {
                if (rig.translationInput > 0.3 || seatDist > CAPTURE_RADIUS * 1.5) capturing = false;
              } else if (seatDist < CAPTURE_RADIUS && relSpeed < CAPTURE_SPEED && rig.translationInput <= 0.3) {
                capturing = true;
              }

              if (capturing) {
                // Velocity servo, not a raw spring: command an approach velocity
                // toward the seat that tapers with distance (capped at
                // CAPTURE_REEL) on top of the pad point's own ω × r, then steer
                // the ship's velocity onto that command. A clamped spring-damper
                // saturates its accel budget on the pull term at range, diluting
                // the damping and orbiting the moving seat for tens of seconds;
                // the servo's commanded velocity always points the error down,
                // so it reels in monotonically (~1/CAPTURE_PULL s per e-fold).
                _seatWorld.copy(SEAT_LOCAL).applyQuaternion(stationGroup.quaternion);
                _capAccel.copy(_seatWorld).sub(rig.position);
                const reel = Math.min(_capAccel.length() * CAPTURE_PULL, CAPTURE_REEL);
                _capAccel.normalize().multiplyScalar(reel).add(_padVel).sub(rig.velocity);
                _capAccel.multiplyScalar(CAPTURE_GAIN);
                const am = _capAccel.length();
                if (am > CAPTURE_MAX_ACCEL) _capAccel.multiplyScalar(CAPTURE_MAX_ACCEL / am);
                rig.velocity.addScaledVector(_capAccel, delta);

                // Right the ship: rotate its up axis toward the pad's up, rate-
                // limited. rotateTowards caps the step at the actual arc, so a
                // near-aligned ship (angle ≈ 0) just holds — no NaN, no snap.
                _shipUp.set(0, 1, 0).applyQuaternion(rig.quaternion);
                _padUp.set(0, 1, 0).applyQuaternion(stationGroup.quaternion);
                _alignQuat.setFromUnitVectors(_shipUp, _padUp);
                _stepQuat.identity().rotateTowards(_alignQuat, CAPTURE_ALIGN_RATE * delta);
                rig.quaternion.premultiply(_stepQuat).normalize();

                // Close and slow enough: hand off to the hard clamp. The field
                // centres you on the seat (no more "wherever you touched down").
                if (seatDist < SNAP_DIST && relSpeed < SNAP_SPEED) {
                  attached = true;
                  capturing = false;
                  seatLocal.copy(SEAT_LOCAL);
                  rig.velocity.copy(_padVel);
                  rig.position.copy(seatLocal).applyQuaternion(stationGroup.quaternion);
                }
              }
            }

            if (attached) {
              landHold += delta;
              timer.statusText = "Touchdown — clamps engaged…";
              if (landHold >= HOLD_SECONDS) phase = "depart";
            } else {
              landHold = 0; // only a hard clamp accrues the hold; capturing doesn't count
              timer.statusText = capturing
                ? "Magnetic capture — field has you"
                : "In the bay — drift into the pad field";
            }
            break;
          case "depart":
            landHold = 0;
            timer.statusText = "Docked ✓ — take off and exit";
            if (!insideCavity) phase = "exit";
            break;
          case "exit":
            timer.statusText = "Exit — clear the station";
            if (Math.abs(_local.x) > OUTER_CLEAR_XY || Math.abs(_local.y) > OUTER_CLEAR_XY || _local.z > OUTER_CLEAR_Z) {
              timer.finish();
            }
            break;
        }
        phaseReadout.phase = PHASE_LABEL[phase];

        // While the field holds the hull it owns the ship's velocity outright,
        // so the rig's flight assist (which brakes hands-off velocity toward
        // zero hard enough to out-muscle the field — and does so more strongly
        // the lower the frame rate) is suspended for the duration. Takes effect
        // in the next frame's rig.update, one frame after the state it mirrors.
        rig.assistBrake = !capturing;
      }

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      // Instrument swap: the scanner (approach/exit) gives way to the landing
      // HUD (land/depart), so the two never overlap in the shared HUD slot.
      const showLanding = phase === "land" || phase === "depart";
      scanner.setVisible(!showLanding);
      landingHud.setVisible(showLanding);

      if (showLanding) {
        // Everything the HUD draws lives in the PAD'S ROTATING LOCAL FRAME. The
        // pad point's world velocity is ω × r; subtracting it and rotating the
        // remainder into station-local axes factors the spin out, so a ship
        // that is rotation-matched (world velocity == pad velocity) reads a
        // near-zero drift even though it's physically sweeping through space.
        _padVel.set(-SPIN * rig.position.y, SPIN * rig.position.x, 0);
        _relVel.copy(rig.velocity).sub(_padVel).applyQuaternion(_invQuat); // world -> station-local
        const overFoot =
          _local.x >= PAD_X_MIN && _local.x <= PAD_X_MAX && _local.z >= PAD_Z_MIN && _local.z <= PAD_Z_MAX;
        const inWindow = insideCavity && overFoot && _local.y <= PAD_CEIL && _local.y >= PAD_FLOOR;
        landingHud.update({
          lateralX: _local.x - PAD_LOCAL.x,
          lateralZ: _local.z - PAD_LOCAL.z,
          height: _local.y - PAD_SURFACE_Y - SHIP_RADIUS, // 0 = resting on the pad
          relVelX: _relVel.x,
          relVelZ: _relVel.z,
          relVelY: _relVel.y, // negative = descending (local +y is up)
          landSpeed: LAND_SPEED,
          inWindow,
          holdFrac: landHold / HOLD_SECONDS,
        });

        // In-world touchdown shadow: repositioned under the ship, clamped inside
        // the cavity so it can't bleed into a wall, coloured by the same green/
        // amber state as the HUD square. Only visible when inside the cavity.
        const green = overFoot && _relVel.length() < LAND_SPEED;
        markerMaterial.color.set(green ? "#22c55e" : "#f59e0b");
        const clamp = CAVITY_HALF - 3;
        marker.position.set(
          THREE.MathUtils.clamp(_local.x, -clamp, clamp),
          PAD_SURFACE_Y + 0.15,
          THREE.MathUtils.clamp(_local.z, -clamp, clamp),
        );
        marker.visible = insideCavity;
      } else {
        marker.visible = false;
        // Scanner tracks the rotating slot, carried into world space by the
        // station's live orientation each frame.
        _targetWorld.copy(SLOT_LOCAL).applyQuaternion(stationGroup.quaternion);
        scanner.update(rig.position, rig.quaternion, [
          { label: "Slot", color: "#7fd4ff", position: _targetWorld },
        ]);
      }

      // Screen-space pad cue — answers "is the pad above or below me": an on-
      // screen diamond when the pad is in view, an edge chevron pointing toward
      // it otherwise. Only while landing/departing, and hidden once clamped (on
      // the pad it's just noise).
      const showPointer = showLanding && !attached;
      pointer.setVisible(showPointer);
      if (showPointer) {
        _padWorld.copy(PAD_LOCAL).applyQuaternion(stationGroup.quaternion);
        pointer.update(camera, _padWorld, "PAD");
      }

      // Capture-field column: shown over the pad through land/depart, hidden in
      // other phases and once clamped. Faint at rest, a brighter pulse while the
      // field actually has the ship.
      if (showLanding && !attached) {
        captureColumn.visible = true;
        captureColumnMaterial.opacity = capturing ? 0.1 + 0.05 * Math.sin(elapsed * 4) : 0.06;
      } else {
        captureColumn.visible = false;
      }
    },
    dispose() {
      rig.dispose();
      scanner.dispose();
      landingHud.dispose();
      pointer.dispose();
      hitFlash.dispose();

      voxels.dispose();
      voxelGeometry.dispose();
      voxelMaterial.dispose();
      padGeometry.dispose();
      padMaterial.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
      captureColumnGeometry.dispose();
      captureColumnMaterial.dispose();
      stripGeometry.dispose();
      greenStripMat.dispose();
      redStripMat.dispose();
      slotBarGeometry.dispose();
      slotPostGeometry.dispose();
      slotFrameMat.dispose();
      scene.remove(stationGroup);

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

export const dockingBayScene: TestScene = {
  id: "docking-bay",
  name: "Course: Docking Bay",
  description:
    "Timed docking at a spinning voxel station — enter the rotating slot, land on the pad, take off and exit clean.",
  setup,
};
