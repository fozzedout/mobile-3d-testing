import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { ScannerHUD } from "../core/scanner-hud.ts";
import { LandingHUD } from "../core/landing-hud.ts";
import { TargetPointer } from "../core/target-pointer.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { buildStarfield } from "../core/starfield.ts";

// Scale viability test: is a truly GIANT rotating station sellable on a phone?
// The old docking-bay drum is ~90 u across; this ring is ~3,780 u across (~42×),
// with the habitable bulk in the outer torus and only a docking hub at the axis.
// "Giant" is sold less by raw dimensions than by scale cues, so the budget goes
// there: thousands of window lights (one InstancedMesh), greeble blocks on the
// hull, strobing beacons, shuttle traffic for parallax, spoke-length light runs,
// haze fog on the far side of the ring, and a long axis-aligned approach lane.

const SHIP_RADIUS = 2.2;
const SPAWN: THREE.Vector3Tuple = [1100, 550, 4200];

// Ring: the main bulk. One fat torus in the z=0 plane, spinning about +Z.
const RING_R = 1740; // centreline radius
const RING_TUBE = 150; // torus tube radius
const RING_DIAMETER = 2 * (RING_R + RING_TUBE); // 3,780 u

// Spokes tie the ring to the hub.
const SPOKES = 6;
const SPOKE_R = 28;

// Central hub: a cylinder on the spin axis. Its +Z end is open — a circular
// aperture into an internal bay ringed with 8 berths (4–8 occupied via GUI).
// Docking at the axis is the physically sensible spot: rotation speed is
// lowest there, and the aperture (Ø184 u) alone dwarfs the whole old station.
const HUB_R = 110;
const HUB_HALF = 260; // hub runs z ∈ [-260, 260]
const BAY_R = 92; // aperture + bay interior radius
const BAY_BACK = 60; // bay floor plane — bay occupies z ∈ [60, 260]
const BERTHS = 8;
const BERTH_SHIP_R = 80; // berthed ship centres sit at this radius on the bay wall
const BERTH_Z = 160;
// Clearance cylinder around the berth ring so the player can't clip parked
// ships: within this z-band the effective bay wall pulls in to the clear radius.
const BERTH_BAND_MIN = 130;
const BERTH_BAND_MAX = 190;
const BERTH_CLEAR_R = 64;

const APERTURE_WORLD = new THREE.Vector3(0, 0, HUB_HALF); // on the spin axis — invariant under the spin

// --- Player berth + magnetic capture, ported from docking-bay.ts ---
// Berth 7 is reserved for the player (the parked-ship slider fills 0..6, so
// with the player clamped in, the bay holds the brief's 4–8 ships). The berth
// frame swaps docking-bay's "down is -y" for "down is radially outward": the
// pad lies ON the bay wall, its up axis points at the spin axis.
const PLAYER_BERTH = 7;
const BERTH_A = (PLAYER_BERTH / BERTHS) * Math.PI * 2;
const PAD_SURFACE_R = 83; // pad box inner face: centred at r=85, 4 thick
const SEAT_R = PAD_SURFACE_R - SHIP_RADIUS - 0.6; // ship-centre rest radius (0.6 clearance, as in docking-bay)
const SEAT_LOCAL = new THREE.Vector3(Math.cos(BERTH_A) * SEAT_R, Math.sin(BERTH_A) * SEAT_R, BERTH_Z);
const PAD_LOCAL = new THREE.Vector3(Math.cos(BERTH_A) * PAD_SURFACE_R, Math.sin(BERTH_A) * PAD_SURFACE_R, BERTH_Z);
const BERTH_UP_LOCAL = new THREE.Vector3(-Math.cos(BERTH_A), -Math.sin(BERTH_A), 0); // radially inward
const BERTH_TAN_LOCAL = new THREE.Vector3(-Math.sin(BERTH_A), Math.cos(BERTH_A), 0);
// The berth-band clearance cylinder protects the parked ships, but the player
// must reach THEIR pad — within this angular sector of the berth the wall
// collider relaxes back to the true bay wall.
const SECTOR_COS = Math.cos(0.28);

// Capture-field tuning: identical numbers to docking-bay (they were settled on
// real-device feedback there, and the ship + pad geometry are the same size).
const CAPTURE_RADIUS = 12;
const CAPTURE_SPEED = 8;
const CAPTURE_PULL = 1;
const CAPTURE_REEL = 5;
const CAPTURE_GAIN = 3;
const CAPTURE_MAX_ACCEL = 15;
const CAPTURE_ALIGN_RATE = 0.9;
const SNAP_DIST = 0.7;
const SNAP_SPEED = 0.8;
const LAND_SPEED = 4;
const HOLD_SECONDS = 1.5;

// Per-frame scratch (see docking-bay.ts for the rationale — the same
// allocation-free pattern, update() is never re-entrant).
const _invQuat = new THREE.Quaternion();
const _local = new THREE.Vector3();
const _pushN = new THREE.Vector3();
const _padVel = new THREE.Vector3();
const _relVel = new THREE.Vector3(); // world (ship − pad point), later rotated station-local for the HUD
const _seatOff = new THREE.Vector3();
const _seatWorld = new THREE.Vector3();
const _padWorld = new THREE.Vector3();
const _capAccel = new THREE.Vector3();
const _shipUp = new THREE.Vector3();
const _berthUp = new THREE.Vector3();
const _alignQuat = new THREE.Quaternion();
const _stepQuat = new THREE.Quaternion();
const _frameQuat = new THREE.Quaternion();
const _spinAxis = new THREE.Vector3(0, 0, 1); // the station's only rotation axis (never mutated)

function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  // Haze starts inside the station's own footprint on purpose: standing at the
  // hub, the FAR side of the ring (~3.5 km away) reads slightly dimmed — the
  // classic "this object has atmosphere-scale depth" cue.
  scene.fog = new THREE.Fog("#04060c", 3200, 19000);
  scene.background = new THREE.Color("#04060c");
  camera.far = 24000;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(11000, 16000, 2800);
  {
    // buildStarfield's defaults are tuned for ~400 u arenas; at this shell
    // distance the attenuated points would vanish, and fog would eat the rest.
    const m = stars.material as THREE.PointsMaterial;
    m.size = 34;
    m.fog = false;
  }
  scene.add(stars);

  const ambient = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(9000, 4000, 6500);
  scene.add(sun);
  const shipLight = new THREE.PointLight(0xffffff, 2, 140);
  scene.add(shipLight);

  // Everything that spins lives under this group (rotation about world +Z).
  const stationGroup = new THREE.Group();
  scene.add(stationGroup);

  // Single-owner disposal lists — every geometry/material created below is
  // registered once, so dispose() can't drift out of sync with the build code.
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const geom = <T extends THREE.BufferGeometry>(g: T): T => (geoms.push(g), g);
  const mat = <T extends THREE.Material>(m: T): T => (mats.push(m), m);

  const hullMat = mat(new THREE.MeshStandardMaterial({ color: "#5f6880", roughness: 0.8, metalness: 0.15 }));
  const hubMat = mat(new THREE.MeshStandardMaterial({ color: "#6a7284", roughness: 0.75, metalness: 0.2 }));
  const darkMat = mat(new THREE.MeshStandardMaterial({ color: "#2c3242", roughness: 0.9, metalness: 0.1 }));

  // --- Outer ring: the main bulk ---
  const ringGeo = geom(new THREE.TorusGeometry(RING_R, RING_TUBE, 28, 220));
  stationGroup.add(new THREE.Mesh(ringGeo, hullMat));

  // --- Spokes + inner-face junction pods ---
  const spokeLen = RING_R - HUB_R;
  const spokeGeo = geom(new THREE.CylinderGeometry(SPOKE_R, SPOKE_R, spokeLen, 12));
  const podGeo = geom(new THREE.BoxGeometry(64, 84, 64));
  const spokeAngles: { c: number; s: number }[] = [];
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    spokeAngles.push({ c, s });
    const spoke = new THREE.Mesh(spokeGeo, hubMat);
    const mid = (RING_R + HUB_R) / 2;
    spoke.position.set(c * mid, s * mid, 0);
    spoke.rotation.z = a - Math.PI / 2; // cylinder +Y → radial direction a
    stationGroup.add(spoke);
    const pod = new THREE.Mesh(podGeo, hullMat);
    pod.position.set(c * (RING_R - RING_TUBE - 26), s * (RING_R - RING_TUBE - 26), 0);
    pod.rotation.z = a;
    stationGroup.add(pod);
  }

  // --- Hub: open-ended shell, front annulus around the aperture, closed back,
  // bay interior wall + floor, aperture glow ring, rear antenna spindle ---
  const hubShellGeo = geom(new THREE.CylinderGeometry(HUB_R, HUB_R, HUB_HALF * 2, 40, 1, true));
  const hubShell = new THREE.Mesh(hubShellGeo, hubMat);
  hubShell.rotation.x = Math.PI / 2; // cylinder Y-axis → spin axis Z
  stationGroup.add(hubShell);

  const hubFrontGeo = geom(new THREE.RingGeometry(BAY_R, HUB_R, 40));
  const hubFront = new THREE.Mesh(hubFrontGeo, hubMat);
  hubFront.position.z = HUB_HALF;
  stationGroup.add(hubFront);

  const hubBackGeo = geom(new THREE.CircleGeometry(HUB_R, 40));
  const hubBack = new THREE.Mesh(hubBackGeo, hubMat);
  hubBack.position.z = -HUB_HALF;
  hubBack.rotation.y = Math.PI;
  stationGroup.add(hubBack);

  const bayDepth = HUB_HALF - BAY_BACK;
  const bayWallGeo = geom(new THREE.CylinderGeometry(BAY_R, BAY_R, bayDepth, 32, 1, true));
  const bayWallMat = mat(new THREE.MeshStandardMaterial({ color: "#2c3242", roughness: 0.9, side: THREE.BackSide }));
  const bayWall = new THREE.Mesh(bayWallGeo, bayWallMat);
  bayWall.rotation.x = Math.PI / 2;
  bayWall.position.z = BAY_BACK + bayDepth / 2;
  stationGroup.add(bayWall);

  const bayFloorGeo = geom(new THREE.CircleGeometry(BAY_R, 32));
  const bayFloor = new THREE.Mesh(bayFloorGeo, darkMat);
  bayFloor.position.z = BAY_BACK;
  stationGroup.add(bayFloor);

  const apertureGeo = geom(new THREE.TorusGeometry(BAY_R + 7, 4.5, 10, 56));
  const apertureMat = mat(new THREE.MeshBasicMaterial({ color: "#7dd3fc" }));
  const aperture = new THREE.Mesh(apertureGeo, apertureMat);
  aperture.position.z = HUB_HALF + 1;
  stationGroup.add(aperture);

  const bayLight = new THREE.PointLight(0x9ec5ff, 3, 500);
  bayLight.position.set(0, 0, 180);
  stationGroup.add(bayLight);

  const antennaGeo = geom(new THREE.CylinderGeometry(10, 3, 140, 8));
  const antenna = new THREE.Mesh(antennaGeo, hubMat);
  antenna.rotation.x = Math.PI / 2;
  antenna.position.z = -HUB_HALF - 70;
  stationGroup.add(antenna);

  // --- Berths: 8 pads on the bay wall, each with a parked ship (4–8 shown) ---
  const shipHullMat = mat(new THREE.MeshStandardMaterial({ color: "#8892a8", roughness: 0.5, metalness: 0.4 }));
  const shipGlowMat = mat(new THREE.MeshBasicMaterial({ color: "#7dd3fc" }));
  const padMat = mat(
    new THREE.MeshStandardMaterial({ color: "#24304a", emissive: "#16a34a", emissiveIntensity: 0.25 }),
  );
  const shipBodyGeo = geom(new THREE.BoxGeometry(8, 5, 18));
  const shipNoseGeo = geom(new THREE.ConeGeometry(4.2, 9, 6));
  const shipEngineGeo = geom(new THREE.BoxGeometry(7, 4, 5));
  const shipGlowGeo = geom(new THREE.BoxGeometry(6, 3, 0.6));
  const padGeo = geom(new THREE.BoxGeometry(14, 4, 26));

  function makeShip(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(shipBodyGeo, shipHullMat);
    const nose = new THREE.Mesh(shipNoseGeo, shipHullMat);
    nose.rotation.x = Math.PI / 2; // cone +Y → +Z: nose points out the aperture
    nose.position.z = 13.5;
    const engine = new THREE.Mesh(shipEngineGeo, shipHullMat);
    engine.position.z = -11.5;
    const glow = new THREE.Mesh(shipGlowGeo, shipGlowMat);
    glow.position.z = -14.2;
    g.add(body, nose, engine, glow);
    return g;
  }

  const playerPadMat = mat(
    new THREE.MeshStandardMaterial({ color: "#0a3d1f", emissive: "#22c55e", emissiveIntensity: 0.9 }),
  );
  const berthedShips: THREE.Group[] = [];
  for (let i = 0; i < BERTHS; i++) {
    const a = (i / BERTHS) * Math.PI * 2;
    const pad = new THREE.Mesh(padGeo, i === PLAYER_BERTH ? playerPadMat : padMat);
    pad.position.set(Math.cos(a) * 85, Math.sin(a) * 85, BERTH_Z);
    pad.rotation.z = a + Math.PI / 2; // pad local +Y → radially inward
    stationGroup.add(pad);
    if (i === PLAYER_BERTH) continue; // the player's berth stays open — its pad glows bright green
    const ship = makeShip();
    ship.position.set(Math.cos(a) * BERTH_SHIP_R, Math.sin(a) * BERTH_SHIP_R, BERTH_Z);
    ship.rotation.z = a + Math.PI / 2; // ship belly to the wall, nose out the aperture
    stationGroup.add(ship);
    berthedShips.push(ship);
  }

  // Magnetic capture volume over the player's pad — same faint green column as
  // docking-bay, here standing radially in from the bay wall.
  const captureColumnGeo = geom(
    new THREE.CylinderGeometry(CAPTURE_RADIUS, CAPTURE_RADIUS, CAPTURE_RADIUS * 1.6, 24, 1, true),
  );
  const captureColumnMat = mat(
    new THREE.MeshBasicMaterial({
      color: "#22c55e",
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const captureColumn = new THREE.Mesh(captureColumnGeo, captureColumnMat);
  {
    const colR = PAD_SURFACE_R - CAPTURE_RADIUS * 0.8;
    captureColumn.position.set(Math.cos(BERTH_A) * colR, Math.sin(BERTH_A) * colR, BERTH_Z);
    captureColumn.rotation.z = BERTH_A + Math.PI / 2; // cylinder axis along the berth's radial
  }
  captureColumn.visible = false;
  stationGroup.add(captureColumn);

  // --- Window lights: the single biggest "it's inhabited and huge" cue.
  // One InstancedMesh: ~2,400 on the ring torus, ~220 on the hub shell, plus
  // runs of lit dots along both faces of every spoke (they trace the spokes'
  // full 1.6 km length, which nothing else makes legible at range). ---
  const windowGeo = geom(new THREE.BoxGeometry(5, 2.5, 0.6));
  const windowMat = mat(new THREE.MeshBasicMaterial({ color: "#ffd9a0" }));
  const RING_WINDOWS = 2400;
  const HUB_WINDOWS = 220;
  const SPOKE_LIGHT_RUNS = 12; // per spoke, per face
  const totalWindows = RING_WINDOWS + HUB_WINDOWS + SPOKES * SPOKE_LIGHT_RUNS * 2;
  const windows = new THREE.InstancedMesh(windowGeo, windowMat, totalWindows);
  // The box windows go subpixel beyond ~1 km, losing the "inhabited city" cue
  // right where it sells the scale — so every window also gets a fixed-size
  // (non-attenuated, 2 px) point sprite that survives any distance. Up close
  // the dot hides inside its own box; far out the dots ARE the windows.
  const windowPointPositions = new Float32Array(totalWindows * 3);
  {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    let idx = 0;
    const one = new THREE.Vector3(1, 1, 1);
    const place = (): void => {
      q.setFromUnitVectors(Z, n);
      windowPointPositions.set([p.x, p.y, p.z], idx * 3);
      windows.setMatrixAt(idx++, m4.compose(p, q, one));
    };
    for (let i = 0; i < RING_WINDOWS; i++) {
      const u = Math.random() * Math.PI * 2; // around the ring circle
      const v = Math.random() * Math.PI * 2; // around the tube
      n.set(Math.cos(u) * Math.cos(v), Math.sin(u) * Math.cos(v), Math.sin(v));
      p.set(Math.cos(u) * RING_R, Math.sin(u) * RING_R, 0).addScaledVector(n, RING_TUBE + 0.5);
      place();
    }
    for (let i = 0; i < HUB_WINDOWS; i++) {
      const a = Math.random() * Math.PI * 2;
      n.set(Math.cos(a), Math.sin(a), 0);
      p.set(Math.cos(a) * (HUB_R + 0.5), Math.sin(a) * (HUB_R + 0.5), -HUB_HALF + 20 + Math.random() * (HUB_HALF * 2 - 50));
      place();
    }
    for (let si = 0; si < SPOKES; si++) {
      const { c, s } = spokeAngles[si];
      for (let i = 0; i < SPOKE_LIGHT_RUNS; i++) {
        const t = HUB_R + 70 + ((RING_R - RING_TUBE - 110) - HUB_R) * (i / (SPOKE_LIGHT_RUNS - 1));
        for (const side of [1, -1]) {
          n.set(0, 0, side);
          p.set(c * t, s * t, side * (SPOKE_R + 0.4));
          place();
        }
      }
    }
  }
  windows.instanceMatrix.needsUpdate = true;
  stationGroup.add(windows);

  const windowPointsGeo = geom(new THREE.BufferGeometry());
  windowPointsGeo.setAttribute("position", new THREE.BufferAttribute(windowPointPositions, 3));
  const windowPointsMat = mat(
    new THREE.PointsMaterial({ color: "#ffd9a0", size: 2, sizeAttenuation: false }),
  );
  stationGroup.add(new THREE.Points(windowPointsGeo, windowPointsMat));

  // --- Greebles: instanced hull blocks breaking up the torus silhouette ---
  const greebleGeo = geom(new THREE.BoxGeometry(1, 1, 1));
  const greebleMat = mat(new THREE.MeshStandardMaterial({ color: "#49536b", roughness: 0.85, metalness: 0.15 }));
  const GREEBLES = 340;
  const greebles = new THREE.InstancedMesh(greebleGeo, greebleMat, GREEBLES);
  {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < GREEBLES; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.random() * Math.PI * 2;
      n.set(Math.cos(u) * Math.cos(v), Math.sin(u) * Math.cos(v), Math.sin(v));
      sc.set(8 + Math.random() * 26, 8 + Math.random() * 26, 4 + Math.random() * 22);
      p.set(Math.cos(u) * RING_R, Math.sin(u) * RING_R, 0).addScaledVector(n, RING_TUBE + sc.z / 2 - 1);
      q.setFromUnitVectors(Z, n);
      greebles.setMatrixAt(i, m4.compose(p, q, sc));
    }
  }
  greebles.instanceMatrix.needsUpdate = true;
  stationGroup.add(greebles);

  // --- Strobing beacons on the ring equator + the antenna tip ---
  const beaconGeo = geom(new THREE.SphereGeometry(5, 8, 8));
  const beaconRedMat = mat(new THREE.MeshBasicMaterial({ color: "#ff4444" }));
  const beaconWhiteMat = mat(new THREE.MeshBasicMaterial({ color: "#ffffff" }));
  const beacons: { mesh: THREE.Mesh; phase: number }[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const mesh = new THREE.Mesh(beaconGeo, i % 2 === 0 ? beaconRedMat : beaconWhiteMat);
    mesh.position.set(Math.cos(a) * (RING_R + RING_TUBE + 4), Math.sin(a) * (RING_R + RING_TUBE + 4), 0);
    stationGroup.add(mesh);
    beacons.push({ mesh, phase: i / 16 });
  }
  {
    const tip = new THREE.Mesh(beaconGeo, beaconRedMat);
    tip.position.set(0, 0, -HUB_HALF - 140);
    stationGroup.add(tip);
    beacons.push({ mesh: tip, phase: 0.5 });
  }

  // --- Shuttle traffic: small craft orbiting the station. Their apparent
  // size against the ring is the parallax cue that nails the scale. ---
  const trafficGroup = new THREE.Group();
  scene.add(trafficGroup);
  const shuttleBodyGeo = geom(new THREE.BoxGeometry(3.5, 2.5, 10));
  const shuttleGlowGeo = geom(new THREE.BoxGeometry(2.8, 1.8, 1));
  const shuttleGlowMat = mat(new THREE.MeshBasicMaterial({ color: "#ffb36b" }));
  interface Shuttle {
    group: THREE.Group;
    r: number;
    z: number;
    w: number; // angular speed, rad/s (sign = direction)
    phase: number;
  }
  const shuttles: Shuttle[] = [];
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(shuttleBodyGeo, shipHullMat);
    const glow = new THREE.Mesh(shuttleGlowGeo, shuttleGlowMat);
    glow.position.z = -5.4;
    g.add(body, glow);
    trafficGroup.add(g);
    const nearHub = i >= 6; // a few tight hub orbits, the rest sweep the ring
    shuttles.push({
      group: g,
      r: nearHub ? 380 + Math.random() * 220 : RING_R + (Math.random() - 0.35) * 620,
      z: (Math.random() - 0.5) * 700,
      w: (0.02 + Math.random() * 0.025) * (Math.random() < 0.5 ? -1 : 1),
      phase: Math.random() * Math.PI * 2,
    });
  }

  // --- Approach lane: two rows of chase-pulsing lights running down the spin
  // axis to the aperture — runway lights for the final, and a depth ruler. ---
  const laneGeo = geom(new THREE.SphereGeometry(3, 6, 6));
  const laneMat = mat(new THREE.MeshBasicMaterial({ color: "#4ade80" }));
  const laneLights: { mesh: THREE.Mesh; order: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const z = 700 + i * 350;
    for (const x of [-45, 45]) {
      const mesh = new THREE.Mesh(laneGeo, laneMat);
      mesh.position.set(x, 0, z);
      scene.add(mesh);
      laneLights.push({ mesh, order: i });
    }
  }

  const rig = new FlightRig(canvas);
  rig.reset(SPAWN);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const scanner = new ScannerHUD(150, 5200);
  const landingHud = new LandingHUD();
  const pointer = new TargetPointer();

  // Capture-field state, mirroring docking-bay: `capturing` is the soft,
  // breakable field hold; `attached` is the hard clamp welding the ship into
  // the rotating frame (world pose regenerated from SEAT_LOCAL every frame).
  let capturing = false;
  let attached = false;
  let holdTime = 0;

  const settings = {
    spin: 0.02, // rad/s — one revolution ≈ 5¼ min; giant structures should turn SLOWLY
    dockedShips: 6,
    traffic: true,
  };
  const readout = {
    status: "Inbound",
    distance: "",
    scale: `Ring Ø ${RING_DIAMETER.toLocaleString()} u — old station ≈ 90 u`,
  };

  function applyDockedShips(): void {
    berthedShips.forEach((s, i) => (s.visible = i < settings.dockedShips));
  }
  applyDockedShips();

  function resetDockingState(): void {
    capturing = false;
    attached = false;
    holdTime = 0;
    rig.assistBrake = true;
    captureColumn.visible = false;
    pointer.setVisible(false);
  }
  function restart(): void {
    rig.reset(SPAWN);
    stationGroup.rotation.z = 0;
    resetDockingState();
  }
  function jumpToFinal(): void {
    rig.reset([0, 80, 1600]);
    resetDockingState();
  }

  rig.registerControls(gui);
  gui.add(readout, "status").name("Status").listen().disable();
  gui.add(readout, "distance").name("Dock distance").listen().disable();
  gui.add(readout, "scale").name("Scale").disable();
  gui.add(settings, "dockedShips", 4, 7, 1).name("Berthed ships (you're #8)").onChange(applyDockedShips);
  gui.add(settings, "spin", 0, 0.06, 0.005).name("Spin (rad/s)");
  gui.add(settings, "traffic").name("Shuttle traffic").onChange((v: boolean) => (trafficGroup.visible = v));
  gui.add({ jumpToFinal }, "jumpToFinal").name("Skip to final approach");
  gui.add({ restart }, "restart").name("Restart approach");

  // Analytic push-out collision, station-local (rotation about z only): torus
  // ring, radial spoke capsules, hub cylinder with the bay carved out. No
  // penalties or timers — this scene tests feel, the collider just keeps the
  // structure solid. Each applied push updates _local so later tests see it.
  function applyPush(localNormal: THREE.Vector3, pen: number): void {
    _pushN.copy(localNormal).applyQuaternion(stationGroup.quaternion).normalize();
    rig.position.addScaledVector(_pushN, pen);
    const into = rig.velocity.dot(_pushN);
    if (into < 0) rig.velocity.addScaledVector(_pushN, -into);
    _local.copy(rig.position).applyQuaternion(_invQuat);
  }

  const _n = new THREE.Vector3();
  function collide(): void {
    // Ring torus
    let rxy = Math.hypot(_local.x, _local.y);
    if (rxy > 1e-3) {
      const dr = rxy - RING_R;
      const d = Math.hypot(dr, _local.z);
      const min = RING_TUBE + SHIP_RADIUS;
      if (d < min) {
        if (d > 1e-4) _n.set((_local.x / rxy) * dr, (_local.y / rxy) * dr, _local.z).divideScalar(d);
        else _n.set(0, 0, 1);
        applyPush(_n, min - d);
      }
    }

    // Spokes (radial capsules in the z=0 plane)
    for (const { c, s } of spokeAngles) {
      const t = THREE.MathUtils.clamp(_local.x * c + _local.y * s, HUB_R, RING_R);
      const dx = _local.x - c * t;
      const dy = _local.y - s * t;
      const d = Math.hypot(dx, dy, _local.z);
      const min = SPOKE_R + SHIP_RADIUS;
      if (d < min) {
        if (d > 1e-4) _n.set(dx, dy, _local.z).divideScalar(d);
        else _n.set(0, 0, 1);
        applyPush(_n, min - d);
      }
    }

    // Hub + bay
    rxy = Math.hypot(_local.x, _local.y);
    const inBayColumn = rxy < BAY_R && _local.z > BAY_BACK - SHIP_RADIUS && _local.z < HUB_HALF + SHIP_RADIUS;
    if (inBayColumn) {
      const inBerthBand = _local.z > BERTH_BAND_MIN && _local.z < BERTH_BAND_MAX;
      // The clearance cylinder guards the PARKED ships — inside the player's
      // own berth sector the wall relaxes to the true bay radius so the pad
      // (and the field's seat point) is actually reachable.
      const towardOwnBerth =
        rxy > 1e-3 && (_local.x * Math.cos(BERTH_A) + _local.y * Math.sin(BERTH_A)) / rxy > SECTOR_COS;
      const wallR = inBerthBand && !towardOwnBerth ? BERTH_CLEAR_R : BAY_R;
      if (rxy > wallR - SHIP_RADIUS && rxy > 1e-3) {
        _n.set(-_local.x / rxy, -_local.y / rxy, 0);
        applyPush(_n, rxy - (wallR - SHIP_RADIUS));
      }
      if (_local.z < BAY_BACK + SHIP_RADIUS) {
        _n.set(0, 0, 1);
        applyPush(_n, BAY_BACK + SHIP_RADIUS - _local.z);
      }
    } else if (rxy < HUB_R + SHIP_RADIUS && Math.abs(_local.z) < HUB_HALF + SHIP_RADIUS) {
      const penRadial = HUB_R + SHIP_RADIUS - rxy;
      const penFront = HUB_HALF + SHIP_RADIUS - _local.z;
      const penBack = _local.z + HUB_HALF + SHIP_RADIUS;
      if (penRadial <= penFront && penRadial <= penBack && rxy > 1e-3) {
        _n.set(_local.x / rxy, _local.y / rxy, 0);
        applyPush(_n, penRadial);
      } else if (penFront <= penBack) {
        _n.set(0, 0, 1);
        applyPush(_n, penFront);
      } else {
        _n.set(0, 0, -1);
        applyPush(_n, penBack);
      }
    }
  }

  let elapsed = 0;

  return {
    manualCamera: true,
    update(delta) {
      elapsed += delta;
      rig.update(delta);

      stationGroup.rotation.z += settings.spin * delta;

      // Clamped: weld the ship into the rotating frame (see docking-bay for the
      // full rationale) — pose regenerated from the local seat, view co-rotated
      // by the frame's delta, velocity slaved to the pad point's ω × r.
      if (attached) {
        rig.position.copy(SEAT_LOCAL).applyQuaternion(stationGroup.quaternion);
        _frameQuat.setFromAxisAngle(_spinAxis, settings.spin * delta);
        rig.quaternion.premultiply(_frameQuat);
        rig.velocity.set(-settings.spin * rig.position.y, settings.spin * rig.position.x, 0);
      }

      _invQuat.copy(stationGroup.quaternion).invert();
      _local.copy(rig.position).applyQuaternion(_invQuat);

      // Deliberate thrust releases the clamp; the ship keeps the tangential
      // velocity it was rotating with and normal physics resume.
      if (attached && rig.translationInput > 0.3) {
        attached = false;
        holdTime = 0;
      }
      if (!attached) collide();

      // Pad-relative kinematics drive the capture field and the landing HUD.
      _padVel.set(-settings.spin * rig.position.y, settings.spin * rig.position.x, 0);
      const relSpeed = _relVel.copy(rig.velocity).sub(_padVel).length();
      const seatDist = _seatOff.copy(SEAT_LOCAL).sub(_local).length();

      if (!attached) {
        if (capturing) {
          if (rig.translationInput > 0.3 || seatDist > CAPTURE_RADIUS * 1.5) capturing = false;
        } else if (seatDist < CAPTURE_RADIUS && relSpeed < CAPTURE_SPEED && rig.translationInput <= 0.3) {
          capturing = true;
        }

        if (capturing) {
          // Velocity servo reeling the ship onto the seat (docking-bay's exact
          // scheme — see the long comment there for why not a spring-damper).
          _seatWorld.copy(SEAT_LOCAL).applyQuaternion(stationGroup.quaternion);
          _capAccel.copy(_seatWorld).sub(rig.position);
          const reel = Math.min(_capAccel.length() * CAPTURE_PULL, CAPTURE_REEL);
          _capAccel.normalize().multiplyScalar(reel).add(_padVel).sub(rig.velocity);
          _capAccel.multiplyScalar(CAPTURE_GAIN);
          const am = _capAccel.length();
          if (am > CAPTURE_MAX_ACCEL) _capAccel.multiplyScalar(CAPTURE_MAX_ACCEL / am);
          rig.velocity.addScaledVector(_capAccel, delta);

          // Right the ship: its up axis eases onto the berth's up — which
          // points at the SPIN AXIS here, not world +y; belly to the bay wall.
          _shipUp.set(0, 1, 0).applyQuaternion(rig.quaternion);
          _berthUp.copy(BERTH_UP_LOCAL).applyQuaternion(stationGroup.quaternion);
          _alignQuat.setFromUnitVectors(_shipUp, _berthUp);
          _stepQuat.identity().rotateTowards(_alignQuat, CAPTURE_ALIGN_RATE * delta);
          rig.quaternion.premultiply(_stepQuat).normalize();

          if (seatDist < SNAP_DIST && relSpeed < SNAP_SPEED) {
            attached = true;
            capturing = false;
            rig.velocity.copy(_padVel);
            rig.position.copy(SEAT_LOCAL).applyQuaternion(stationGroup.quaternion);
          }
        }
      }
      if (attached) holdTime += delta;
      // Suspend the rig's hands-off brake while the field owns velocity
      // (docking-bay's fix: the assist out-muscles the field, frame-rate-dependently).
      rig.assistBrake = !capturing;

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      // Beacons strobe (short flash, staggered around the ring).
      for (const b of beacons) {
        b.mesh.visible = (elapsed * 0.45 + b.phase) % 1 < 0.12;
      }

      // Approach lane chase pulse, sweeping toward the aperture.
      for (const l of laneLights) {
        const pulse = Math.max(0, Math.sin(elapsed * 3 - l.order * 0.7));
        l.mesh.scale.setScalar(1 + pulse * 1.6);
      }

      // Shuttle traffic (world frame — they fly, they don't spin with the hull).
      if (trafficGroup.visible) {
        for (const sh of shuttles) {
          const a = sh.phase + sh.w * elapsed;
          const x = Math.cos(a) * sh.r;
          const y = Math.sin(a) * sh.r;
          sh.group.position.set(x, y, sh.z);
          const a2 = a + (sh.w > 0 ? 0.03 : -0.03);
          sh.group.lookAt(Math.cos(a2) * sh.r, Math.sin(a2) * sh.r, sh.z);
        }
      }

      const dist = rig.position.distanceTo(APERTURE_WORLD);
      readout.distance = `${Math.round(dist).toLocaleString()} u`;
      const rxyLocal = Math.hypot(_local.x, _local.y);
      const insideBay = rxyLocal < BAY_R && _local.z > BAY_BACK && _local.z < HUB_HALF;
      if (attached) {
        readout.status =
          holdTime < HOLD_SECONDS
            ? "Touchdown — clamps engaging…"
            : `Docked ✓ — ${settings.dockedShips + 1}/${BERTHS} berths full (thrust to release)`;
      } else if (capturing) {
        readout.status = "Magnetic capture — field has you";
      } else if (insideBay) {
        readout.status = "In the bay — drift into the green pad's field";
      } else if (dist < 700) {
        readout.status = "Final — thread the glowing aperture";
      } else if (dist < 2600) {
        readout.status = "Approach — line up with the hub axis";
      } else {
        readout.status = "Inbound — the glow ahead is the dock; the ring is 3.8 km wide";
      }

      // Instrument swap, as in docking-bay: the scanner hands over to the
      // landing HUD inside the bay, so the shared HUD slot never doubles up.
      const showLanding = insideBay || attached;
      scanner.setVisible(!showLanding);
      landingHud.setVisible(showLanding);

      if (showLanding) {
        // Everything on the gauge lives in the BERTH'S ROTATING FRAME: "up" is
        // radially inward, "lateral X" is the bay-wall tangent, "lateral Z" the
        // spin axis. Rotation-matched with the pad reads as zero drift.
        _relVel.applyQuaternion(_invQuat); // world rel vel (computed above) -> station-local
        const latX =
          (_local.x - PAD_LOCAL.x) * BERTH_TAN_LOCAL.x + (_local.y - PAD_LOCAL.y) * BERTH_TAN_LOCAL.y;
        const latZ = _local.z - BERTH_Z;
        const height = PAD_SURFACE_R - rxyLocal - SHIP_RADIUS; // 0 = resting on the pad
        const relX = _relVel.x * BERTH_TAN_LOCAL.x + _relVel.y * BERTH_TAN_LOCAL.y;
        const relY = _relVel.x * BERTH_UP_LOCAL.x + _relVel.y * BERTH_UP_LOCAL.y; // negative = descending onto the pad
        const overFoot = Math.abs(latX) < 7 && Math.abs(latZ) < 13; // pad footprint: 14 × 26
        landingHud.update({
          lateralX: latX,
          lateralZ: latZ,
          height,
          relVelX: relX,
          relVelZ: _relVel.z,
          relVelY: relY,
          landSpeed: LAND_SPEED,
          inWindow: overFoot && height > -0.5 && height < 2.5,
          holdFrac: attached ? Math.min(1, holdTime / HOLD_SECONDS) : 0,
        });
      }

      // Screen-space berth cue + capture column, hidden once clamped.
      const showPointer = showLanding && !attached;
      pointer.setVisible(showPointer);
      _padWorld.copy(PAD_LOCAL).applyQuaternion(stationGroup.quaternion);
      if (showPointer) pointer.update(camera, _padWorld, "PAD");
      captureColumn.visible = showPointer;
      if (showPointer) captureColumnMat.opacity = capturing ? 0.1 + 0.05 * Math.sin(elapsed * 4) : 0.06;

      if (!showLanding) {
        // Scanner tracks the dock aperture from range; once close, the berth
        // pad itself joins so you can line up the entry with your own slot.
        scanner.update(
          rig.position,
          rig.quaternion,
          dist < 1600
            ? [
                { label: "Dock", color: "#7dd3fc", position: APERTURE_WORLD },
                { label: "Berth", color: "#22c55e", position: _padWorld },
              ]
            : [{ label: "Dock", color: "#7dd3fc", position: APERTURE_WORLD }],
        );
      }
    },
    dispose() {
      rig.dispose();
      scanner.dispose();
      landingHud.dispose();
      pointer.dispose();

      windows.dispose();
      greebles.dispose();
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
      scene.remove(stationGroup, trafficGroup);
      for (const l of laneLights) scene.remove(l.mesh);

      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      scene.remove(stars, ambient, sun, shipLight);

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

export const megaStationScene: TestScene = {
  id: "mega-station",
  name: "Mega Station (Scale Test)",
  description:
    "Approach a colossal rotating ring station — the bulk lives in the 3.8 km outer ring, the axis hub berths up to 8 ships; a magnetic capture field guides you onto your own pad.",
  setup,
};
