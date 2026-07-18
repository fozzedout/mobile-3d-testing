import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { VirtualJoystick } from "../core/virtual-joystick.ts";
import { buildStarfield } from "../core/starfield.ts";

// ============================================================================
// Walk: Stanford Torus — a first-person walking tour of the 1975 NASA/Ames
// "Stanford Torus" study space station, rendered at TRUE SCALE so the sheer
// size of the megastructure lands on a phone screen.
//
// The 1975 study: a wheel 1.8 km in diameter (major radius R = 900 m) with a
// 130 m tube (tube radius 65 m), spun at ~1 RPM to give ~1 g on its rim floor,
// housing ~10,000 people, reached from a low-gravity central hub by SIX spokes.
//
// Physics, one idea: the wheel does NOT move in world space (no rotating
// geometry, no Coriolis). "Down" is radially OUTWARD from the spin axis (world
// +Z). Spin is sold by wheeling the starfield about Z at −ω (~6°/s), seen
// through the rim skylights and hub windows. The single load-bearing formula is
//     g_local = ω²·d / 9.81   (d = player's distance from the axis)
// which reads exactly 1.00 g at the rim floor (d = 940), falls continuously in
// an elevator, and bottoms out near 0.06 g at the hub — the same formula drives
// the readout, the movement traction, and the head-bob everywhere.
// ============================================================================

// --- World model (1 unit = 1 metre) ---------------------------------------
const R = 900; // major radius (tube-centre circle); wheel is 1.8 km across
const TUBE = 65; // tube radius; the habitat tube is 130 m in diameter
const D_RIM = 940; // rim habitat floor: a flat band 40 m outboard of the tube centre
const LAT_RIM = 51; // half-width of the flat floor along z (chord of the 65 m tube at 40 m out)
const D_HUB = 60; // hub drum floor radius
const LAT_HUB = 40; // hub drum half-length along z
const SUN_R = 835; // "sun line": the tube's radially-innermost circle (R − TUBE + slack), the light source
const G0 = 9.81;
const OMEGA = Math.sqrt(G0 / D_RIM); // ≈ 0.1022 rad/s ≈ 0.98 RPM → exactly 1.00 g at d = 940
const EYE = 1.7; // eye height above the floor — the eye sits 1.7 m CLOSER to the axis than the floor

// --- Movement -------------------------------------------------------------
const WALK = 3.0; // honest walking pace, m/s
const JOG = 12.0; // "Jog ×4" so a full 5.9 km rim lap is feasible in ~8 min
const LOOK_RATE = 1.7; // rad/s of yaw/pitch at full look-stick deflection
const PITCH_LIMIT = 1.35;
const ACCEL = 8.0; // base traction (1/s); scaled by g so the hub feels floaty
const RIDE_SECONDS = 35; // spoke-elevator ride time, rim ↔ hub
const PAD_RADIUS = 7; // how close (metres of arc) you must stand to an elevator pad to board
const BOARD_HOLD = 1.0; // seconds of stillness on the pad before the lift departs

const SPOKES = 6;
const SPOKE_STEP = (Math.PI * 2) / SPOKES; // 60°
const SECTOR_STEP = SPOKE_STEP; // one sector per 60° gap between spokes
const QUARTER_STEP = SECTOR_STEP / 4; // A1..A4, ~236 m of arc each

// Six sectors A–F, each between two spokes, NASA-flavoured alternating uses.
// Each accent tints its lighting trim, its building blocks, and its signage.
interface Sector {
  letter: string;
  name: string;
  short: string;
  color: string;
  kind: "plaza" | "resid" | "agri" | "commerce" | "labs";
}
const SECTORS: Sector[] = [
  { letter: "A", name: "PLAZA & COMMONS", short: "Plaza", color: "#35d6e0", kind: "plaza" },
  { letter: "B", name: "RESIDENTIAL TERRACES", short: "Residential", color: "#f2e4c4", kind: "resid" },
  { letter: "C", name: "AGRICULTURE", short: "Agriculture", color: "#4fd06a", kind: "agri" },
  { letter: "D", name: "COMMERCE & SERVICES", short: "Commerce", color: "#f5a623", kind: "commerce" },
  { letter: "E", name: "RESIDENTIAL TERRACES", short: "Residential", color: "#f2e4c4", kind: "resid" },
  { letter: "F", name: "LABS & LIGHT INDUSTRY", short: "Labs", color: "#e0417f", kind: "labs" },
];

const SPAWN_THETA = 0.03; // just past spoke S1 (0°) → "A1 · Plaza"

// --- Per-frame scratch (module scope; update() is never re-entrant, so sharing
// is safe and the walk path stays allocation-free on phones) ----------------
const _er = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _lateral = new THREE.Vector3(0, 0, 1);
const _negTangent = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _qBase = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _AX_Y = new THREE.Vector3(0, 1, 0);
const _AX_X = new THREE.Vector3(1, 0, 0);

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function smoother(t: number): number {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function normAngle(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}
// Set the local floor frame (radial-in "up", ring tangent, radial-out) at angle θ.
function setFrame(theta: number): void {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  _er.set(c, s, 0); // radially outward = "down"
  _up.set(-c, -s, 0); // radially inward = "up"
  _tangent.set(-s, c, 0); // direction of increasing θ
  _negTangent.set(s, -c, 0);
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Canvas-generated signage (CanvasTexture). Text is sized BIG — a portrait
// phone at 55° vertical FOV shows only ~27° horizontally, so signs have to
// shout to be legible.
// ---------------------------------------------------------------------------
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function makeTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  draw(g);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function gateTexture(sector: Sector, spokeName: string): THREE.CanvasTexture {
  return makeTexture(1024, 384, (g) => {
    g.fillStyle = "#0a0d13";
    g.fillRect(0, 0, 1024, 384);
    g.fillStyle = sector.color;
    g.globalAlpha = 0.16;
    g.fillRect(0, 0, 1024, 384);
    g.globalAlpha = 1;
    g.strokeStyle = sector.color;
    g.lineWidth = 12;
    g.strokeRect(14, 14, 996, 356);
    g.fillStyle = sector.color;
    g.fillRect(14, 14, 996, 60);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#0a0d13";
    g.font = "bold 40px system-ui, sans-serif";
    g.fillText(`SPOKE ${spokeName} · ELEVATOR TO HUB`, 512, 46);
    g.fillStyle = "#ffffff";
    g.font = "bold 150px system-ui, sans-serif";
    g.fillText(`SECTOR ${sector.letter}`, 512, 190);
    g.fillStyle = sector.color;
    g.font = "bold 64px system-ui, sans-serif";
    g.fillText(sector.name, 512, 300);
  });
}

function decalTexture(text: string, color: string): THREE.CanvasTexture {
  return makeTexture(512, 512, (g) => {
    g.clearRect(0, 0, 512, 512);
    g.fillStyle = color;
    g.globalAlpha = 0.14;
    roundRect(g, 40, 40, 432, 432, 60);
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = 16;
    g.strokeStyle = color;
    roundRect(g, 40, 40, 432, 432, 60);
    g.stroke();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.font = "bold 240px system-ui, sans-serif";
    g.fillText(text, 256, 276);
  });
}

function padTexture(text: string, color: string): THREE.CanvasTexture {
  return makeTexture(512, 512, (g) => {
    g.clearRect(0, 0, 512, 512);
    g.fillStyle = color;
    g.globalAlpha = 0.18;
    g.beginPath();
    g.arc(256, 256, 210, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = 14;
    g.strokeStyle = color;
    g.beginPath();
    g.arc(256, 256, 210, 0, Math.PI * 2);
    g.stroke();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.font = "bold 92px system-ui, sans-serif";
    g.fillText(text, 256, 240);
    g.font = "bold 60px system-ui, sans-serif";
    g.fillStyle = color;
    g.fillText("▲ HUB", 256, 330);
  });
}

function bannerTexture(): THREE.CanvasTexture {
  return makeTexture(1024, 384, (g) => {
    g.fillStyle = "#07120b";
    g.fillRect(0, 0, 1024, 384);
    g.strokeStyle = "#4fe08a";
    g.lineWidth = 12;
    g.strokeRect(14, 14, 996, 356);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#4fe08a";
    g.font = "bold 74px system-ui, sans-serif";
    g.fillText("YOU STARTED HERE", 512, 150);
    g.fillStyle = "#ffffff";
    g.font = "bold 150px system-ui, sans-serif";
    g.fillText("A1 · PLAZA", 512, 270);
  });
}

// ---------------------------------------------------------------------------
// Tube interior shell: a full-360° torus band, built with the flat floor cut
// out as its own strip below. Two φ-bands are left OPEN as skylights, filled
// with dark glass panels the wheeling starfield shows through.
// ---------------------------------------------------------------------------
const RING_SEG = 288;
const TUBE_SEG = 20;
const SKY_QUADS = new Set([6, 7, 13, 14]); // tube-segment bands left open as rim skylights
// Tube-segment bands lying FULLY under the flat street (|lat| < 51 across their whole
// φ range) are skipped too: the street replaces them visually, and keeping them gave
// two surfaces 0–25 m apart fighting over kilometre-scale depth slots on phone GPUs —
// the distant street curve dissolved into a z-fight checkerboard on real devices.
const UNDER_STREET_QUADS = new Set([0, 1, 18, 19]); // φ ±36° → |lat| ≤ 38 m, r ≥ 952: strictly under the street band

function buildShell(): THREE.BufferGeometry {
  const cols = RING_SEG + 1;
  const rows = TUBE_SEG + 1;
  const pos = new Float32Array(cols * rows * 3);
  const col = new Float32Array(cols * rows * 3);
  const base = new THREE.Color();
  for (let i = 0; i < cols; i++) {
    const theta = (i / RING_SEG) * Math.PI * 2;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    for (let j = 0; j < rows; j++) {
      const phi = (j / TUBE_SEG) * Math.PI * 2;
      const r = R + TUBE * Math.cos(phi);
      const idx = (i * rows + j) * 3;
      pos[idx] = r * ct;
      pos[idx + 1] = r * st;
      pos[idx + 2] = TUBE * Math.sin(phi);
      // Panels read as panelling: brighter toward the ceiling, faint per-cell noise.
      // Kept LIGHT overall — a habitat lit by its sun-line, not a night tunnel; the
      // first build's dark palette killed the floor-curving-up money shot entirely.
      const lift = 0.62 + 0.30 * (0.5 - 0.5 * Math.cos(phi)); // floor darker, ceiling lighter
      const n = 0.9 + 0.1 * Math.sin(i * 1.7 + j * 2.3);
      base.setRGB(0.58 * lift * n, 0.63 * lift * n, 0.72 * lift * n);
      col[idx] = base.r;
      col[idx + 1] = base.g;
      col[idx + 2] = base.b;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < RING_SEG; i++) {
    for (let j = 0; j < TUBE_SEG; j++) {
      if (SKY_QUADS.has(j)) continue; // leave the skylight bands open
      if (UNDER_STREET_QUADS.has(j)) continue; // the street strip replaces these
      const a = i * rows + j;
      const b = (i + 1) * rows + j;
      const c = (i + 1) * rows + (j + 1);
      const d = i * rows + (j + 1);
      index.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

function buildSkylights(): THREE.BufferGeometry {
  const cols = RING_SEG + 1;
  const rows = TUBE_SEG + 1;
  const pos = new Float32Array(cols * rows * 3);
  for (let i = 0; i < cols; i++) {
    const theta = (i / RING_SEG) * Math.PI * 2;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    for (let j = 0; j < rows; j++) {
      const phi = (j / TUBE_SEG) * Math.PI * 2;
      const r = R + TUBE * Math.cos(phi);
      const idx = (i * rows + j) * 3;
      pos[idx] = r * ct;
      pos[idx + 1] = r * st;
      pos[idx + 2] = TUBE * Math.sin(phi);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < RING_SEG; i++) {
    for (let j = 0; j < TUBE_SEG; j++) {
      if (!SKY_QUADS.has(j)) continue;
      const a = i * rows + j;
      const b = (i + 1) * rows + j;
      const c = (i + 1) * rows + (j + 1);
      const d = i * rows + (j + 1);
      index.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// Flat street: a ring-quad strip at d = D_RIM spanning ±LAT_RIM along z. The
// curving tube shell rises away behind it — the street visibly climbs and
// vanishes into the ceiling a few hundred metres ahead: the money shot.
function buildStreet(): THREE.BufferGeometry {
  const cols = RING_SEG + 1;
  const pos = new Float32Array(cols * 2 * 3);
  const uv = new Float32Array(cols * 2 * 2);
  for (let i = 0; i < cols; i++) {
    const theta = (i / RING_SEG) * Math.PI * 2;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    for (let e = 0; e < 2; e++) {
      const lat = e === 0 ? -LAT_RIM : LAT_RIM;
      const vi = (i * 2 + e) * 3;
      pos[vi] = D_RIM * ct;
      pos[vi + 1] = D_RIM * st;
      pos[vi + 2] = lat;
      const ui = (i * 2 + e) * 2;
      uv[ui] = i / RING_SEG;
      uv[ui + 1] = e;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < RING_SEG; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2 + 1;
    const d = (i + 1) * 2;
    index.push(a, b, d, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

function streetTexture(): THREE.CanvasTexture {
  return makeTexture(32, 256, (g) => {
    g.fillStyle = "#3d4452";
    g.fillRect(0, 0, 32, 256);
    // Longitudinal lane lines (constant along the ring, varying across lat) — bright
    // enough that the street stays legible hundreds of metres up the curve.
    g.fillStyle = "rgba(215,228,245,0.55)";
    for (const v of [64, 128, 192]) g.fillRect(0, v - 1, 32, 2);
    g.fillStyle = "rgba(215,228,245,0.22)";
    for (const v of [32, 96, 160, 224]) g.fillRect(0, v - 1, 32, 1);
  });
}

// The axis triple MUST be right-handed (xa × ya = za): setFromRotationMatrix on an
// improper (det −1) basis yields a garbage orientation — a left-handed triple once had
// the elevator pad rings standing bolt upright across the street as giant hoops.
function setBasis(m: THREE.Object3D, xa: THREE.Vector3, ya: THREE.Vector3, za: THREE.Vector3, p: THREE.Vector3): void {
  const mat = new THREE.Matrix4().makeBasis(xa, ya, za);
  m.quaternion.setFromRotationMatrix(mat);
  m.position.copy(p);
}

function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  // --- Override the global fog/camera.far so we can see across the wheel,
  // then restore them in dispose (main.ts's 8–30 fog would bury everything). ---
  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevFar = camera.far;
  const prevNear = camera.near;
  const interiorTint = new THREE.Color("#151b25");
  scene.fog = new THREE.Fog(interiorTint, 220, 1100); // hides the far tube curving up; keeps the hub clear
  scene.background = interiorTint.clone();
  camera.far = 2600; // hub windows must reach the far rim skylights
  // Depth precision scales with near/far: the shared renderer's 0.05 near against a
  // 2600 far starves a phone's depth buffer so badly that surfaces metres apart
  // checkerboard-fight ~1 km up the curve. Nothing in a WALKING scene ever gets
  // within half a metre of the eye, so buy back ~100× precision here.
  camera.near = 0.5;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const root = new THREE.Group();
  scene.add(root);
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => (geometries.push(g), g);
  const trackM = <T extends THREE.Material>(m: T): T => (materials.push(m), m);
  const trackT = <T extends THREE.Texture>(t: T): T => (textures.push(t), t);

  // --- Lights: ambient + two directionals + emissive sun-line point lights.
  // No per-sector dynamic lights (mobile) — emissive materials carry the trim. ---
  root.add(new THREE.AmbientLight(0xffffff, 0.95));
  const dirA = new THREE.DirectionalLight(0xffffff, 0.35);
  dirA.position.set(0, 0, 1);
  const dirB = new THREE.DirectionalLight(0xffffff, 0.25);
  dirB.position.set(0, 0, -1);
  root.add(dirA, dirB);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const p = new THREE.PointLight(0xfff2d6, 2.4, 1800, 1.0);
    p.position.set(SUN_R * Math.cos(a), SUN_R * Math.sin(a), 0);
    root.add(p);
  }
  const hubLight = new THREE.PointLight(0xbfe0ff, 2.6, 420, 1.0);
  hubLight.position.set(0, 0, 0);
  root.add(hubLight);

  // --- Starfield: outside the wheel, spun about Z at −ω (fog-immune so it stays
  // visible through the skylights and hub windows). This IS the sense of spin. ---
  const stars = buildStarfield(1200, 2400, 2600);
  (stars.material as THREE.PointsMaterial).fog = false;
  const starGroup = new THREE.Group();
  starGroup.add(stars);
  root.add(starGroup);

  // --- Tube shell + skylights + street ---
  const shellGeo = track(buildShell());
  const shellMat = trackM(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.05, flatShading: true, side: THREE.DoubleSide }));
  root.add(new THREE.Mesh(shellGeo, shellMat));

  const skyGeo = track(buildSkylights());
  const skyMat = trackM(new THREE.MeshStandardMaterial({ color: "#0a1420", transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, roughness: 1 }));
  root.add(new THREE.Mesh(skyGeo, skyMat));

  const streetGeo = track(buildStreet());
  const streetTex = trackT(streetTexture());
  streetTex.wrapS = THREE.RepeatWrapping;
  streetTex.wrapT = THREE.ClampToEdgeWrapping;
  // polygonOffset biases the street toward the camera where the shell's wall base
  // grazes its edges — belt and braces on top of the near-plane + skipped-quad fixes.
  const streetMat = trackM(new THREE.MeshStandardMaterial({ map: streetTex, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  root.add(new THREE.Mesh(streetGeo, streetMat));

  // --- Sun line: the emissive inner-ceiling circle lighting the whole rim ---
  const sunGeo = track(new THREE.TorusGeometry(SUN_R, 1.8, 6, RING_SEG));
  const sunMat = trackM(new THREE.MeshBasicMaterial({ color: "#fff4dc", fog: true }));
  root.add(new THREE.Mesh(sunGeo, sunMat)); // ring lies in XY plane, axis = Z

  // --- Buildings: ONE InstancedMesh, dressed per sector, colored by accent,
  // kept off the central street (|lat| < 12) and clear of quarter markers. ---
  interface Block {
    theta: number;
    lat: number;
    h: number;
    w: number; // along tangent
    depth: number; // along lateral
    color: THREE.Color;
  }
  const blocks: Block[] = [];
  const rng = mulberry(1975);
  const tmpColor = new THREE.Color();
  for (let s = 0; s < SECTORS.length; s++) {
    const sector = SECTORS[s];
    const base = new THREE.Color(sector.color);
    const t0 = s * SECTOR_STEP;
    const push = (theta: number, lat: number, h: number, w: number, depth: number, tintMul: number): void => {
      if (Math.abs(lat) < 12) return; // keep the street clear
      if (Math.abs(lat) + depth / 2 > LAT_RIM - 1) lat = Math.sign(lat) * (LAT_RIM - 1 - depth / 2);
      // Skip a slim margin around quarter boundaries so floor decals stay visible.
      const q = normAngle(theta) % QUARTER_STEP;
      if (q < 0.004 || q > QUARTER_STEP - 0.004) return;
      tmpColor.copy(base).multiplyScalar(tintMul);
      blocks.push({ theta, lat, h, w, depth, color: tmpColor.clone() });
    };
    if (sector.kind === "resid") {
      // Terraced rows stepping up the tube walls: farther from the street = taller.
      const rows = [18, 30, 42];
      for (let side = -1; side <= 1; side += 2) {
        for (let ri = 0; ri < rows.length; ri++) {
          const lat = side * rows[ri];
          const h = 8 + ri * 8;
          for (let a = 0.03; a < SECTOR_STEP - 0.03; a += 0.05) {
            push(t0 + a, lat, h, 12, 9, 0.7 + rng() * 0.3);
          }
        }
      }
    } else if (sector.kind === "agri") {
      // Long low greenhouse slabs, greenish.
      for (let side = -1; side <= 1; side += 2) {
        for (let a = 0.05; a < SECTOR_STEP - 0.05; a += 0.14) {
          push(t0 + a, side * 30, 5, 42, 26, 0.75 + rng() * 0.25);
        }
      }
    } else if (sector.kind === "commerce") {
      // Mid-height varied blocks near the street.
      for (let side = -1; side <= 1; side += 2) {
        for (let a = 0.04; a < SECTOR_STEP - 0.04; a += 0.06) {
          push(t0 + a, side * (16 + rng() * 12), 10 + rng() * 16, 10, 10, 0.6 + rng() * 0.4);
        }
      }
    } else if (sector.kind === "labs") {
      // Fewer, bulkier blocks.
      for (let side = -1; side <= 1; side += 2) {
        for (let a = 0.08; a < SECTOR_STEP - 0.08; a += 0.12) {
          push(t0 + a, side * (20 + rng() * 18), 16 + rng() * 14, 20, 18, 0.55 + rng() * 0.35);
        }
      }
    } else {
      // Plaza: low, wide, sparse.
      for (let side = -1; side <= 1; side += 2) {
        for (let a = 0.06; a < SECTOR_STEP - 0.06; a += 0.1) {
          push(t0 + a, side * (18 + rng() * 16), 5 + rng() * 5, 16, 14, 0.6 + rng() * 0.4);
        }
      }
    }
  }
  const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const boxMat = trackM(new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1, emissive: 0x111214, emissiveIntensity: 0.4, flatShading: true }));
  const buildings = new THREE.InstancedMesh(boxGeo, boxMat, blocks.length);
  {
    const bm = new THREE.Matrix4();
    const scl = new THREE.Vector3();
    const pos = new THREE.Vector3();
    for (let i = 0; i < blocks.length; i++) {
      const bl = blocks[i];
      setFrame(bl.theta);
      const dCenter = D_RIM - bl.h / 2; // base on the floor, rising inward toward the axis
      pos.set(dCenter * Math.cos(bl.theta), dCenter * Math.sin(bl.theta), bl.lat);
      bm.makeBasis(_tangent, _up, _lateral);
      bm.scale(scl.set(bl.w, bl.h, bl.depth));
      bm.setPosition(pos);
      buildings.setMatrixAt(i, bm);
      buildings.setColorAt(i, bl.color);
    }
    buildings.instanceMatrix.needsUpdate = true;
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
  }
  root.add(buildings);

  // --- Shared small geometries for signage/pads (scaled per instance) ---
  const planeGeo = track(new THREE.PlaneGeometry(1, 1));
  const ringGeo = track(new THREE.RingGeometry(0.72, 1, 40));

  // Helper: a flat floor decal facing "up" (toward the axis) at (theta, lat).
  // Road-marking orientation: text width runs ACROSS the street (X = lateral) and its
  // top points forward along the walk (+θ), so an approaching walker reads it upright —
  // the tube's curvature even tilts distant decals toward the viewer, like a billboard.
  const addFloorDecal = (theta: number, lat: number, size: number, tex: THREE.Texture): void => {
    setFrame(theta);
    const mat = trackM(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    const m = new THREE.Mesh(planeGeo, mat);
    m.scale.set(size, size, 1);
    const p = new THREE.Vector3((D_RIM - 0.4) * Math.cos(theta), (D_RIM - 0.4) * Math.sin(theta), lat);
    setBasis(m, _lateral, _tangent, _up, p);
    root.add(m);
  };

  // Quarter markers: a glowing "C3"-style decal at every quarter boundary.
  for (let s = 0; s < SECTORS.length; s++) {
    for (let q = 0; q < 4; q++) {
      const theta = s * SECTOR_STEP + q * QUARTER_STEP + 0.004;
      const label = `${SECTORS[s].letter}${q + 1}`;
      addFloorDecal(theta, 0, 26, trackT(decalTexture(label, SECTORS[s].color)));
    }
  }

  // --- Per-spoke structure: bulkhead arch, gate sign, spoke shaft, elevator pad ---
  // The doorway hole must stay STRICTLY inside the radius-63 disc: earcut's
  // behaviour is undefined when a hole crosses the outer contour, and the first
  // build's door (x to 66, corners at radius ~68) triangulated into overlapping
  // garbage that rendered as a bright self-fighting checkerboard on every GPU.
  // x 10..59, y ±20 keeps the farthest corner at radius 62.3. In world terms the
  // door spans d 910–959: from 30 m above the street down past floor level (the
  // below-floor part is buried), 40 m wide on the 102 m street.
  const archShape = new THREE.Shape();
  archShape.absarc(0, 0, 63, 0, Math.PI * 2, false);
  const door = new THREE.Path();
  door.moveTo(10, -20);
  door.lineTo(59, -20);
  door.lineTo(59, 20);
  door.lineTo(10, 20);
  door.lineTo(10, -20);
  archShape.holes.push(door);
  const archGeo = track(new THREE.ShapeGeometry(archShape, 48));
  const archMat = trackM(new THREE.MeshStandardMaterial({ color: "#3a4252", roughness: 0.85, metalness: 0.25, side: THREE.DoubleSide, flatShading: true }));
  const shaftGeo = track(new THREE.CylinderGeometry(4.5, 4.5, 130, 16, 1, true));
  const shaftMat = trackM(new THREE.MeshStandardMaterial({ color: "#2a3040", emissive: "#3a5a80", emissiveIntensity: 0.5, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide }));
  const padMat = trackM(new THREE.MeshBasicMaterial({ color: "#7fe0ff", transparent: true, opacity: 0.85, side: THREE.DoubleSide }));

  interface Pad {
    theta: number;
    x: number;
    y: number;
  }
  const rimPads: Pad[] = [];
  const hubPads: Pad[] = [];
  for (let k = 0; k < SPOKES; k++) {
    const theta = k * SPOKE_STEP;
    const sector = SECTORS[k]; // +θ side sector: spoke k opens Sector (A+k)
    const spokeName = `S${k + 1}`;
    setFrame(theta);

    // Bulkhead arch across the tube cross-section (street passes the central hole).
    const arch = new THREE.Mesh(archGeo, archMat);
    setBasis(arch, _er, _lateral, _negTangent, new THREE.Vector3(R * Math.cos(theta), R * Math.sin(theta), 0));
    root.add(arch);

    // Huge gate sign above the doorway, facing the −θ approach (main tour direction).
    // FrontSide: the back of a DoubleSide sign is mirrored text — worse than nothing.
    const gateMat = trackM(new THREE.MeshBasicMaterial({ map: trackT(gateTexture(sector, spokeName)), transparent: true }));
    const gate = new THREE.Mesh(planeGeo, gateMat);
    gate.scale.set(80, 30, 1);
    {
      const gd = R - 25; // above the door, toward the ceiling
      const p = new THREE.Vector3(gd * Math.cos(theta), gd * Math.sin(theta), 0).addScaledVector(_negTangent, 2);
      setBasis(gate, _lateral, _up, _negTangent, p);
    }
    root.add(gate);

    // Spoke structure: a PAIR of columns at the street's edges rather than one fat
    // shaft on the centreline — a single centred column bisected the walkway and
    // parked itself exactly in front of the gate sign (real-device feedback). The
    // pair frames the doorway and sign (sign spans lat ±40; columns sit at ±44,
    // clear of it from any approach angle) and still reads as the spoke plunging
    // through the ceiling toward the hub. The actual ride interior is rideGroup.
    const sd = (D_RIM + SUN_R) / 2;
    for (const side of [-44, 44]) {
      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      setBasis(shaft, _lateral, _er, _tangent, new THREE.Vector3(sd * Math.cos(theta), sd * Math.sin(theta), side));
      root.add(shaft);
    }

    // Rim elevator pad + "S1 → HUB" decal on the street.
    const pad = new THREE.Mesh(ringGeo, padMat);
    pad.scale.set(6, 6, 1);
    setBasis(pad, _lateral, _tangent, _up, new THREE.Vector3((D_RIM - 0.35) * Math.cos(theta), (D_RIM - 0.35) * Math.sin(theta), 0));
    root.add(pad);
    addFloorDecal(theta + 0.012, 0, 10, trackT(padTexture(spokeName, "#7fe0ff")));
    rimPads.push({ theta, x: (D_RIM - EYE) * Math.cos(theta), y: (D_RIM - EYE) * Math.sin(theta) });
    hubPads.push({ theta, x: 0, y: 0 });
  }

  // --- Spawn marking: a green start ring on the floor + a banner ---
  {
    setFrame(SPAWN_THETA);
    const ringMat = trackM(new THREE.MeshBasicMaterial({ color: "#4fe08a", transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.scale.set(7, 7, 1);
    setBasis(ring, _lateral, _tangent, _up, new THREE.Vector3((D_RIM - 0.3) * Math.cos(SPAWN_THETA), (D_RIM - 0.3) * Math.sin(SPAWN_THETA), 0));
    root.add(ring);
    // The banner greets a walker COMPLETING the loop (they arrive moving +θ, so it must
    // face −θ, like the gate signs). It hangs essentially overhead at spawn — 22 m up,
    // 3 m ahead is ~82° of elevation, far outside the phone frustum at level pitch — so
    // it never walls off the opening view, yet reads clearly from ~100 m out on return.
    const banTheta = SPAWN_THETA + 3 / D_RIM;
    setFrame(banTheta);
    const banMat = trackM(new THREE.MeshBasicMaterial({ map: trackT(bannerTexture()), transparent: true }));
    const ban = new THREE.Mesh(planeGeo, banMat);
    ban.scale.set(44, 16, 1);
    const bd = D_RIM - 22;
    const p = new THREE.Vector3(bd * Math.cos(banTheta), bd * Math.sin(banTheta), 0);
    setBasis(ban, _lateral, _up, _negTangent, p);
    root.add(ban);
  }

  // --- Hub drum: interior radius D_HUB, |lat| ≤ LAT_HUB, end-cap windows, core column ---
  const hubGroup = new THREE.Group();
  root.add(hubGroup);
  const hubWallGeo = track(new THREE.CylinderGeometry(D_HUB, D_HUB, LAT_HUB * 2, 96, 1, true));
  hubWallGeo.rotateX(Math.PI / 2); // cylinder axis Y → Z (the spin axis)
  // Distinctly brighter than the background tint — the first palette rendered the
  // drum within a few RGB points of the fog color and the hub read as a black void.
  const hubWallMat = trackM(new THREE.MeshStandardMaterial({ color: "#464f61", emissive: "#1d3050", emissiveIntensity: 0.55, roughness: 0.9, metalness: 0.1, side: THREE.BackSide, flatShading: true }));
  hubGroup.add(new THREE.Mesh(hubWallGeo, hubWallMat));
  const capRingGeo = track(new THREE.RingGeometry(11, D_HUB, 64));
  const capRingMat = trackM(new THREE.MeshStandardMaterial({ color: "#57627a", roughness: 0.8, metalness: 0.3, side: THREE.DoubleSide }));
  const capGlassGeo = track(new THREE.CircleGeometry(D_HUB - 1, 64));
  const capGlassMat = trackM(new THREE.MeshBasicMaterial({ color: "#0a1626", transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
  for (const z of [-LAT_HUB, LAT_HUB]) {
    const glass = new THREE.Mesh(capGlassGeo, capGlassMat);
    glass.position.z = z;
    hubGroup.add(glass);
    const ringc = new THREE.Mesh(capRingGeo, capRingMat);
    ringc.position.z = z;
    hubGroup.add(ringc);
  }
  const coreGeo = track(new THREE.CylinderGeometry(10, 10, LAT_HUB * 2, 24, 1, false));
  coreGeo.rotateX(Math.PI / 2);
  const coreMat = trackM(new THREE.MeshStandardMaterial({ color: "#2a3244", emissive: "#5a7cff", emissiveIntensity: 1.0, roughness: 0.5, metalness: 0.4, flatShading: true }));
  hubGroup.add(new THREE.Mesh(coreGeo, coreMat));
  // Two glowing hoops around the drum + a lit strip at each spoke angle: the bare
  // drum read as a featureless void from inside — every look direction needs SOME
  // structure to anchor scale and orientation at 0.06 g.
  const hoopGeo = track(new THREE.TorusGeometry(D_HUB - 1.2, 0.5, 6, 72));
  const hoopMat = trackM(new THREE.MeshBasicMaterial({ color: "#9fd8ff" }));
  for (const z of [-22, 22]) {
    const hoop = new THREE.Mesh(hoopGeo, hoopMat);
    hoop.position.z = z; // torus already lies in the XY plane, matching the drum
    hubGroup.add(hoop);
  }
  const stripGeo = track(new THREE.BoxGeometry(1.4, 0.4, 56));
  for (let k = 0; k < SPOKES; k++) {
    const a = k * SPOKE_STEP;
    const stripMat = trackM(new THREE.MeshBasicMaterial({ color: SECTORS[k].color }));
    const strip = new THREE.Mesh(stripGeo, stripMat);
    setFrame(a);
    setBasis(strip, _negTangent, _er, _lateral, new THREE.Vector3((D_HUB - 0.6) * Math.cos(a), (D_HUB - 0.6) * Math.sin(a), 0));
    hubGroup.add(strip);
  }

  // Handrail-ish boxes + 6 hub elevator pads at the six spoke angles.
  const railGeo = track(new THREE.BoxGeometry(3, 1, 1));
  const railMat = trackM(new THREE.MeshStandardMaterial({ color: "#5c6678", roughness: 0.7, metalness: 0.3 }));
  const hubPadMat = trackM(new THREE.MeshBasicMaterial({ color: "#7fe0ff", transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  for (let k = 0; k < SPOKES; k++) {
    const theta = k * SPOKE_STEP;
    setFrame(theta);
    const p = new THREE.Vector3((D_HUB - 0.35) * Math.cos(theta), (D_HUB - 0.35) * Math.sin(theta), 0);
    const hp = new THREE.Mesh(ringGeo, hubPadMat);
    hp.scale.set(5, 5, 1);
    setBasis(hp, _lateral, _tangent, _up, p);
    hubGroup.add(hp);
    for (let z = -30; z <= 30; z += 20) {
      const rail = new THREE.Mesh(railGeo, railMat);
      setBasis(rail, _tangent, _up, _lateral, new THREE.Vector3(D_HUB * Math.cos(theta), D_HUB * Math.sin(theta), z));
      hubGroup.add(rail);
    }
  }

  // --- Ride shaft: one long interior tube + static passing rings, built along
  // +X (spoke 0) and rotated about Z to whichever spoke is being ridden. Shown
  // only during a ride; the rings sweep past to sell the vertical motion. ---
  const rideGroup = new THREE.Group();
  rideGroup.visible = false;
  root.add(rideGroup);
  const rideTubeGeo = track(new THREE.CylinderGeometry(8, 8, 920, 20, 1, true));
  rideTubeGeo.rotateZ(Math.PI / 2); // axis Y → X (radial for spoke 0)
  const rideTubeMat = trackM(new THREE.MeshStandardMaterial({ color: "#1c2029", emissive: "#25406a", emissiveIntensity: 0.35, roughness: 0.6, metalness: 0.4, side: THREE.BackSide }));
  const rideTube = new THREE.Mesh(rideTubeGeo, rideTubeMat);
  rideTube.position.x = (D_HUB + D_RIM) / 2;
  rideGroup.add(rideTube);
  const rideRingGeo = track(new THREE.TorusGeometry(7.6, 0.5, 6, 24));
  const rideRingMat = trackM(new THREE.MeshBasicMaterial({ color: "#8fd0ff" }));
  for (let d = D_HUB + 20; d < D_RIM; d += 45) {
    const rr = new THREE.Mesh(rideRingGeo, rideRingMat);
    rr.position.x = d;
    rr.rotation.y = Math.PI / 2; // torus plane ⟂ X
    rideGroup.add(rr);
  }

  // ------------------------------------------------------------------------
  // Controls: a move stick (left half) + a rate-based look stick (right half),
  // both floating VirtualJoysticks, following FlightRig's idiom.
  // ------------------------------------------------------------------------
  const moveStick = new VirtualJoystick(document.body, { color: "#8fe3a0" });
  const lookStick = new VirtualJoystick(document.body, { color: "#4da3ff" });
  const pointers = new Map<number, { x: number; y: number }>();
  let moveId: number | null = null;
  let lookId: number | null = null;
  let moveOx = 0;
  let moveOy = 0;
  let lookOx = 0;
  let lookOy = 0;

  const onDown = (e: PointerEvent): void => {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; plain delivery still works */
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const isRight = e.clientX >= window.innerWidth / 2;
    if (!isRight && moveId === null) {
      moveId = e.pointerId;
      moveOx = e.clientX;
      moveOy = e.clientY;
      moveStick.show(e.clientX, e.clientY);
    } else if (isRight && lookId === null) {
      lookId = e.pointerId;
      lookOx = e.clientX;
      lookOy = e.clientY;
      lookStick.show(e.clientX, e.clientY);
    }
  };
  const onMove = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerId === moveId) moveStick.feed(e.clientX - moveOx, e.clientY - moveOy);
    else if (e.pointerId === lookId) lookStick.feed(e.clientX - lookOx, e.clientY - lookOy);
  };
  const onUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (e.pointerId === moveId) {
      moveId = null;
      moveStick.hide();
    }
    if (e.pointerId === lookId) {
      lookId = null;
      lookStick.hide();
    }
  };
  canvas.addEventListener("pointerdown", onDown, { passive: true });
  canvas.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointerup", onUp, { passive: true });
  canvas.addEventListener("pointercancel", onUp, { passive: true });

  // ------------------------------------------------------------------------
  // Mini-map overlay: a fixed top-left canvas (below the scene dropdown; clear
  // of the GUI panel top-right and the fire-zone bottom-left). ~10 Hz.
  // ------------------------------------------------------------------------
  const mapEl = document.createElement("canvas");
  mapEl.className = "torus-map";
  const MAP = 132;
  const mratio = Math.min(window.devicePixelRatio, 2);
  mapEl.width = MAP * mratio;
  mapEl.height = MAP * mratio;
  mapEl.style.width = `${MAP}px`;
  mapEl.style.height = `${MAP}px`;
  document.body.appendChild(mapEl);
  const mctx = mapEl.getContext("2d") as CanvasRenderingContext2D;
  mctx.scale(mratio, mratio);

  // ------------------------------------------------------------------------
  // Player + region state (allocation-free per frame).
  // ------------------------------------------------------------------------
  let theta = SPAWN_THETA;
  let lat = 0;
  let dist = D_RIM;
  let heading = 0;
  let pitch = 0;
  let vT = 0; // tangential walk velocity, m/s
  let vL = 0; // lateral walk velocity, m/s
  let bob = 0;
  type Region = "rim" | "hub" | "ascend" | "descend";
  let region: Region = "rim";
  let rideT = 0;
  let rideSpoke = 0;
  let dwell = 0;
  let needLeavePad = false;
  let lapAccum = 0;
  let laps = 0;
  let walked = 0;
  let mapAccum = 0;
  let persistent = "Walk the rim — a full loop returns to A1.";

  const params = { jog: false };
  const readout = { location: "A1 · Plaza", gravity: "1.00 g", radius: "940 m", walked: "0.00 km", status: persistent };

  const returnToSpawn = (): void => {
    region = "rim";
    theta = SPAWN_THETA;
    lat = 0;
    dist = D_RIM;
    heading = 0;
    pitch = 0;
    vT = 0;
    vL = 0;
    rideT = 0;
    dwell = 0;
    needLeavePad = false;
    persistent = "Returned to A1 · Plaza.";
  };

  gui.add(readout, "location").name("Location").listen().disable();
  gui.add(readout, "gravity").name("Gravity").listen().disable();
  gui.add(readout, "radius").name("Radius").listen().disable();
  gui.add(readout, "walked").name("Walked").listen().disable();
  gui.add(readout, "status").name("Status").listen().disable();
  gui.add(params, "jog").name("Jog ×4");
  gui.add({ returnToSpawn }, "returnToSpawn").name("Return to spawn");

  function locationLabel(): string {
    if (region === "hub") return "Hub Core · 0.06 g";
    if (region === "ascend" || region === "descend") return `Spoke S${rideSpoke + 1} · Elevator`;
    const n = normAngle(theta);
    const s = Math.floor(n / SECTOR_STEP) % SECTORS.length;
    const q = Math.floor((n % SECTOR_STEP) / QUARTER_STEP) + 1;
    return `${SECTORS[s].letter}${q} · ${SECTORS[s].short}`;
  }

  function drawMap(): void {
    const cx = MAP / 2;
    const cy = MAP / 2;
    const Rm = MAP / 2 - 14;
    mctx.clearRect(0, 0, MAP, MAP);
    // Rim ring.
    mctx.strokeStyle = "rgba(150,165,185,0.6)";
    mctx.lineWidth = 2;
    mctx.beginPath();
    mctx.arc(cx, cy, Rm, 0, Math.PI * 2);
    mctx.stroke();
    // Sector letters (mid-sector) + spoke ticks.
    mctx.textAlign = "center";
    mctx.textBaseline = "middle";
    for (let s = 0; s < SECTORS.length; s++) {
      const mid = (s + 0.5) * SECTOR_STEP;
      mctx.fillStyle = SECTORS[s].color;
      mctx.font = "bold 12px system-ui, sans-serif";
      mctx.fillText(SECTORS[s].letter, cx + Math.cos(mid) * (Rm - 12), cy - Math.sin(mid) * (Rm - 12));
      const sa = s * SPOKE_STEP;
      mctx.strokeStyle = "rgba(127,224,255,0.7)";
      mctx.beginPath();
      mctx.moveTo(cx + Math.cos(sa) * (Rm - 5), cy - Math.sin(sa) * (Rm - 5));
      mctx.lineTo(cx + Math.cos(sa) * (Rm + 4), cy - Math.sin(sa) * (Rm + 4));
      mctx.stroke();
    }
    // Green start dot.
    mctx.fillStyle = "#4fe08a";
    mctx.beginPath();
    mctx.arc(cx + Math.cos(SPAWN_THETA) * Rm, cy - Math.sin(SPAWN_THETA) * Rm, 3, 0, Math.PI * 2);
    mctx.fill();
    // Player dot (radius scaled by dist so the hub sits near centre) + heading tick.
    const pr = Rm * (dist / D_RIM);
    const px = cx + Math.cos(theta) * pr;
    const py = cy - Math.sin(theta) * pr;
    const face = theta + Math.PI / 2 + heading;
    mctx.strokeStyle = "#ffffff";
    mctx.lineWidth = 2;
    mctx.beginPath();
    mctx.moveTo(px, py);
    mctx.lineTo(px + Math.cos(face) * 9, py - Math.sin(face) * 9);
    mctx.stroke();
    mctx.fillStyle = "#ffffff";
    mctx.beginPath();
    mctx.arc(px, py, 3.5, 0, Math.PI * 2);
    mctx.fill();
  }

  return {
    manualCamera: true,
    update(dt: number) {
      // Spin is sold entirely by wheeling the stars about Z at −ω.
      starGroup.rotation.z -= OMEGA * dt;

      const moveInput = Math.hypot(moveStick.value.x, moveStick.value.y);
      const g = (OMEGA * OMEGA * dist) / G0; // = dist / D_RIM

      // --- Look (rate control, both while walking and mid-ride) ---
      heading -= lookStick.value.x * LOOK_RATE * dt;
      pitch -= lookStick.value.y * LOOK_RATE * dt;
      if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
      if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;

      setFrame(theta);

      if (region === "rim" || region === "hub") {
        const floorD = region === "rim" ? D_RIM : D_HUB;
        const latLimit = region === "rim" ? LAT_RIM : LAT_HUB;
        dist = floorD;

        // Build the camera orientation so we can walk relative to where we look.
        _basis.makeBasis(_lateral, _up, _negTangent);
        _qBase.setFromRotationMatrix(_basis);
        _qYaw.setFromAxisAngle(_AX_Y, heading);
        _qPitch.setFromAxisAngle(_AX_X, pitch);
        camera.quaternion.copy(_qBase).multiply(_qYaw).multiply(_qPitch);

        // Horizontal forward/right (project out the up component), matched to look.
        _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion).addScaledVector(_up, -_fwd.dot(_up));
        if (_fwd.lengthSq() < 1e-6) _fwd.copy(_tangent);
        _fwd.normalize();
        _right.set(1, 0, 0).applyQuaternion(camera.quaternion).addScaledVector(_up, -_right.dot(_up)).normalize();

        const maxSpeed = params.jog ? JOG : WALK;
        _desired.copy(_fwd).multiplyScalar(-moveStick.value.y).addScaledVector(_right, moveStick.value.x);
        if (_desired.lengthSq() > 1) _desired.normalize();
        const tgtT = _desired.dot(_tangent) * maxSpeed;
        const tgtL = _desired.z * maxSpeed; // lateral = world z

        // Traction scaled by local g: the hub (~0.06 g) is floaty and slippery.
        const traction = THREE.MathUtils.lerp(0.25, 1, g);
        const f = 1 - Math.exp(-ACCEL * traction * dt);
        vT += (tgtT - vT) * f;
        vL += (tgtL - vL) * f;

        const dTheta = (vT * dt) / dist;
        theta += dTheta;
        lat += vL * dt;
        if (lat > latLimit) {
          lat = latLimit;
          vL = 0; // soft-clamp: slide along the wall
        } else if (lat < -latLimit) {
          lat = -latLimit;
          vL = 0;
        }

        // Lap detection (rim only): signed Δθ accumulated to a full turn.
        if (region === "rim") {
          lapAccum += dTheta;
          if (Math.abs(lapAccum) >= Math.PI * 2) {
            laps++;
            lapAccum -= Math.sign(lapAccum) * Math.PI * 2;
            persistent = `Full circuit — 5.9 km around the rim ✓ (lap ${laps})`;
          }
        }

        const speed = Math.hypot(vT, vL);
        walked += speed * dt;
        // Head-bob dies out at the hub (scaled by g) and with speed.
        bob += speed * dt * 1.9;
        const bobAmt = Math.sin(bob) * 0.05 * Math.min(speed / WALK, 1) * g;

        // --- Elevator boarding: stand on a pad, stick released, for BOARD_HOLD ---
        const pads = region === "rim" ? rimPads : hubPads;
        let onPad = -1;
        for (let k = 0; k < pads.length; k++) {
          const arc = Math.abs(angleDiff(theta, pads[k].theta)) * dist;
          if (arc < PAD_RADIUS && Math.abs(lat) < PAD_RADIUS) {
            onPad = k;
            break;
          }
        }
        if (onPad < 0) needLeavePad = false;
        if (onPad >= 0 && !needLeavePad && moveInput < 0.05) {
          dwell += dt;
          if (dwell >= BOARD_HOLD) {
            rideSpoke = onPad;
            theta = onPad * SPOKE_STEP;
            lat = 0;
            vT = 0;
            vL = 0;
            rideT = 0;
            dwell = 0;
            rideGroup.rotation.z = onPad * SPOKE_STEP;
            rideGroup.visible = true;
            region = region === "rim" ? "ascend" : "descend";
          } else {
            persistent = `Elevator S${onPad + 1} — hold still to board… (${(BOARD_HOLD - dwell).toFixed(1)}s)`;
          }
        } else {
          dwell = 0;
        }

        // Eye sits EYE metres above the floor = EYE closer to the axis.
        const eyeD = dist - EYE;
        camera.position.set(eyeD * Math.cos(theta), eyeD * Math.sin(theta), lat).addScaledVector(_up, bobAmt);
      } else {
        // --- Riding: theta/lat locked to the spoke; d animates with a smooth
        // ease so the gravity readout falls (or rises) live every frame. ---
        rideT += dt / RIDE_SECONDS;
        const s = smoother(rideT);
        const ascending = region === "ascend";
        dist = ascending ? THREE.MathUtils.lerp(D_RIM, D_HUB, s) : THREE.MathUtils.lerp(D_HUB, D_RIM, s);
        theta = rideSpoke * SPOKE_STEP;
        lat = 0;
        const gRide = (OMEGA * OMEGA * dist) / G0;
        persistent = ascending
          ? `Ascending — ${gRide.toFixed(2)} g and falling…`
          : `Descending — ${gRide.toFixed(2)} g and rising…`;

        _basis.makeBasis(_lateral, _up, _negTangent);
        _qBase.setFromRotationMatrix(_basis);
        _qYaw.setFromAxisAngle(_AX_Y, heading);
        _qPitch.setFromAxisAngle(_AX_X, pitch);
        camera.quaternion.copy(_qBase).multiply(_qYaw).multiply(_qPitch);
        const eyeD = dist - EYE;
        camera.position.set(eyeD * Math.cos(theta), eyeD * Math.sin(theta), lat);

        if (rideT >= 1) {
          region = ascending ? "hub" : "rim";
          dist = ascending ? D_HUB : D_RIM;
          needLeavePad = true; // don't instantly re-board on arrival
          dwell = 0;
          rideGroup.visible = false;
          if (ascending) {
            // Arrival vista: face along the drum with a slight upward pitch. The phone's
            // ~27° horizontal FOV is a keyhole, so this exact framing was picked from a
            // screenshotted panorama — it catches a glow hoop's far arc sweeping across
            // the curved drum wall, which reads instantly as "small spinning drum".
            heading = 0;
            pitch = 0.22;
          }
          persistent = ascending ? "Hub core — 0.06 g. Walk the drum; a pad rides you back down." : "Back on the rim floor — 1.00 g.";
        }
      }

      // --- Readouts ---
      readout.location = locationLabel();
      readout.gravity = `${((OMEGA * OMEGA * dist) / G0).toFixed(2)} g`;
      readout.radius = `${Math.round(dist)} m`;
      readout.walked = `${(walked / 1000).toFixed(2)} km`;
      readout.status = persistent;

      mapAccum += dt;
      if (mapAccum >= 0.1) {
        mapAccum = 0;
        drawMap();
      }
    },
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      moveStick.dispose();
      lookStick.dispose();
      mapEl.remove();

      scene.remove(root);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();

      scene.fog = prevFog;
      scene.background = prevBackground;
      camera.far = prevFar;
      camera.near = prevNear;
      camera.position.set(3, 2, 4);
      camera.quaternion.identity();
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.enabled = true;
      controls.update();
    },
  };
}

export const torusWalkScene: TestScene = {
  id: "torus-walk",
  name: "Walk: Torus Station",
  description:
    "First-person walking tour of a true-scale 1975 NASA Stanford Torus: pace the 5.9 km rim past lettered sector signage (A–F), ride a spoke elevator to the low-gravity hub, and feel the megastructure's size.",
  setup,
};
