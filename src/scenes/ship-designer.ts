import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { buildSdfHullGeometry, type HullPrimitive } from "./ship-hull-sdf.ts";

// One grid cell is 4 world units on a side. Space is an UNBOUNDED integer lattice:
// cell (x,y,z) sits at world (x*CELL, y*CELL, z*CELL) and coords may go negative. There
// are no w×h×d walls anymore — a design grows by attaching one block to the face of
// another (see the drag flow). Functional modules plus optional structure fairings
// are the only occupancy; the exterior shell is generated from that occupancy.
// +z is the REAR of the ship (engines exhaust that way); -z is the nose.
const CELL = 4;

type ModuleType = "reactor" | "engine" | "fuel" | "weapon" | "shield" | "cargo" | "crew" | "structure";
// Set-piece module sizes. A module also carries a LIVE footprint (dx,dy,dz); ROTATION
// yaws it by swapping dx<->dz (dy is untouched — yaw only in v2). SIZE_DIMS is just the
// unrotated default. S and XL are cubes, so their rotation is a visual no-op (fine).
// Footprints in cells: S = 1, M = 2 (1x1x2), L = 4 (2x1x2), XL = 8 (2x2x2).
type ModuleSize = "S" | "M" | "L" | "XL";
/** Fairing silhouette for structure modules — drives preview mesh + skinned SDF. */
type StructureShape = "block" | "cone" | "wedge" | "dome" | "semi";
type ViewMode = "internal" | "exterior" | "performance";
type PrefabName = "fighter" | "trader";
type HullStyle = "skinned" | "plated" | "box";

const MODULE_TYPES: ModuleType[] = ["reactor", "engine", "fuel", "weapon", "shield", "cargo", "crew", "structure"];
const MODULE_SIZES: ModuleSize[] = ["S", "M", "L", "XL"];
const STRUCTURE_SHAPES: StructureShape[] = ["block", "cone", "wedge", "dome", "semi"];
const STRUCTURE_SHAPE_LABEL: Record<StructureShape, string> = {
  block: "Block",
  cone: "Cone",
  wedge: "Wedge",
  dome: "Dome",
  semi: "Semi",
};

// Footprint dims (dx, dy, dz) in cells for each size. dx = width (x), dy = height (y),
// dz = length (z). This is the unrotated default; rotation swaps dx and dz per-module.
const SIZE_DIMS: Record<ModuleSize, [number, number, number]> = {
  S: [1, 1, 1],
  M: [1, 1, 2],
  L: [2, 1, 2],
  XL: [2, 2, 2],
};
// Bigger modules are more efficient per unit of OUTPUT: output stats scale by
// (cells × efficiency) while mass and all consumption stats scale by cells alone, so a
// large block gives more thrust/power/cargo per mass but draws proportionally more total
// power and heat and demands a contiguous block of free space. See recomputeStats().
const SIZE_EFFICIENCY: Record<ModuleSize, number> = { S: 1, M: 1.05, L: 1.1, XL: 1.15 };

interface ModuleSpec {
  mass: number;
  /** + generates power, - consumes it. */
  power: number;
  heat: number;
  thrust: number;
  fuelBurn: number;
  fuelCap: number;
  dps: number;
  shieldHP: number;
  cargoCap: number;
  color: string;
}

// Deliberately tuned so trade-offs bite: reactors are heavy and hot but the only power
// source; engines add thrust yet burn fuel and draw power; cargo is pure dead mass.
// These are PER-CELL base values; a module's contribution is scaled by its footprint.
const SPECS: Record<ModuleType, ModuleSpec> = {
  reactor: { mass: 8, power: 12, heat: 4, thrust: 0, fuelBurn: 0, fuelCap: 0, dps: 0, shieldHP: 0, cargoCap: 0, color: "#ffd24d" },
  engine: { mass: 6, power: -2, heat: 2, thrust: 12, fuelBurn: 2, fuelCap: 0, dps: 0, shieldHP: 0, cargoCap: 0, color: "#ff8a3b" },
  fuel: { mass: 5, power: 0, heat: 0, thrust: 0, fuelBurn: 0, fuelCap: 100, dps: 0, shieldHP: 0, cargoCap: 0, color: "#8fe3a0" },
  weapon: { mass: 4, power: -2, heat: 3, thrust: 0, fuelBurn: 0, fuelCap: 0, dps: 10, shieldHP: 0, cargoCap: 0, color: "#ff5d7a" },
  shield: { mass: 5, power: -3, heat: 0, thrust: 0, fuelBurn: 0, fuelCap: 0, dps: 0, shieldHP: 40, cargoCap: 0, color: "#4da3ff" },
  cargo: { mass: 7, power: 0, heat: 0, thrust: 0, fuelBurn: 0, fuelCap: 0, dps: 0, shieldHP: 0, cargoCap: 20, color: "#b08de0" },
  crew: { mass: 3, power: -1, heat: 0, thrust: 0, fuelBurn: 0, fuelCap: 0, dps: 0, shieldHP: 0, cargoCap: 0, color: "#e8eef8" },
  // Fairing / filler: light dead mass only. Pads the exterior envelope so the shell can
  // taper or fill gaps without buying another reactor, cargo bay, etc.
  structure: { mass: 1, power: 0, heat: 0, thrust: 0, fuelBurn: 0, fuelCap: 0, dps: 0, shieldHP: 0, cargoCap: 0, color: "#6a7388" },
};

interface Cell {
  x: number;
  y: number;
  z: number;
}

interface PrefabDef {
  hullColor: string;
  modules: (Cell & { type: ModuleType })[];
}

// Both prefabs are hand-authored to validate clean under every rule below. Every module
// is size "S": the prefab stats are regression baselines (fighter mass 42 / speed 34.3 /
// power balance 1; trader mass 78 / cargo 80) and must not shift. Authored coords are
// arbitrary (loadPrefab re-centers them on the origin), only their relative layout matters.
const PREFABS: Record<PrefabName, PrefabDef> = {
  // Fighter: excellent movement (3 engines / low mass), no cargo, tight power budget.
  fighter: {
    hullColor: "#5a6b8c",
    modules: [
      { type: "crew", x: 1, y: 0, z: 0 },
      { type: "weapon", x: 0, y: 0, z: 1 },
      { type: "reactor", x: 1, y: 0, z: 1 },
      { type: "weapon", x: 2, y: 0, z: 1 },
      { type: "fuel", x: 1, y: 0, z: 2 },
      { type: "engine", x: 0, y: 0, z: 3 },
      { type: "engine", x: 1, y: 0, z: 3 },
      { type: "engine", x: 2, y: 0, z: 3 },
    ],
  },
  // Trader: basic guns, decent cargo, moderate movement (heavy, only 2 engines).
  trader: {
    hullColor: "#7a6a55",
    modules: [
      { type: "weapon", x: 0, y: 0, z: 0 },
      { type: "crew", x: 1, y: 0, z: 0 },
      { type: "shield", x: 2, y: 0, z: 0 },
      { type: "reactor", x: 1, y: 0, z: 1 },
      { type: "reactor", x: 2, y: 0, z: 1 },
      { type: "cargo", x: 0, y: 0, z: 2 },
      { type: "cargo", x: 1, y: 0, z: 2 },
      { type: "cargo", x: 2, y: 0, z: 2 },
      { type: "cargo", x: 3, y: 0, z: 2 },
      { type: "fuel", x: 1, y: 0, z: 3 },
      { type: "fuel", x: 2, y: 0, z: 3 },
      { type: "engine", x: 1, y: 0, z: 4 },
      { type: "engine", x: 2, y: 0, z: 4 },
    ],
  },
};

interface Module {
  type: ModuleType;
  size: ModuleSize;
  /** Structure fairing style; ignored for functional modules (always "block"). */
  shape: StructureShape;
  // Anchor = the module's minimum corner cell; the footprint occupies
  // [x, x+dx) x [y, y+dy) x [z, z+dz). dims start from size and mutate on rotation.
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  mesh: THREE.Mesh;
  // Each module owns its material: validity red-tint, selection glow, drag preview tint
  // and the performance heat-lerp are all per-module, so a shared per-type material can't
  // express them. The BoxGeometry (one per dims triple) and the icon texture (one per
  // type+size) are, by contrast, shared across every matching module.
  material: THREE.MeshStandardMaterial;
}

const RED = new THREE.Color("#ff3b3b");

// The six orthogonal neighbor directions, shared by adjacency / connectivity scans.
const DIRS: THREE.Vector3Tuple[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ---- pictographic icon textures ------------------------------------------------------
// Module colors alone are unreadable on a phone, so every block wears a white
// pictogram baked onto a colored tile (like classic ship-editor games). Glyphs are drawn
// with canvas 2D paths — NOT emoji/text — because emoji rendering varies across
// platforms. One 128x128 texture per (type, size); the size label is stamped in the
// corner. A soft dark shadow backs the white strokes so they read on light tiles too.
// The palette bar reuses these same canvases via toDataURL(), so buttons match the blocks.
function drawGlyph(g: CanvasRenderingContext2D, type: ModuleType): void {
  g.strokeStyle = "#ffffff";
  g.fillStyle = "#ffffff";
  g.lineWidth = 9;
  g.lineJoin = "round";
  g.lineCap = "round";
  switch (type) {
    case "reactor": {
      // Lightning bolt, filled polygon.
      g.beginPath();
      g.moveTo(72, 22);
      g.lineTo(42, 70);
      g.lineTo(60, 70);
      g.lineTo(52, 106);
      g.lineTo(88, 56);
      g.lineTo(68, 56);
      g.closePath();
      g.fill();
      break;
    }
    case "engine": {
      // Nozzle trapezoid (narrow top, flared bottom) with 3 flame strokes below.
      g.beginPath();
      g.moveTo(50, 32);
      g.lineTo(78, 32);
      g.lineTo(90, 74);
      g.lineTo(38, 74);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(50, 80); g.lineTo(46, 104);
      g.moveTo(64, 80); g.lineTo(64, 108);
      g.moveTo(78, 80); g.lineTo(82, 104);
      g.stroke();
      break;
    }
    case "fuel": {
      // Droplet outline: a top tip curving down to a rounded bottom bulge.
      g.beginPath();
      g.moveTo(64, 22);
      g.quadraticCurveTo(90, 62, 90, 82);
      g.arc(64, 82, 26, 0, Math.PI);
      g.quadraticCurveTo(38, 62, 64, 22);
      g.closePath();
      g.stroke();
      break;
    }
    case "weapon": {
      // Crosshair: ring + 4 ticks + center dot.
      g.beginPath();
      g.arc(64, 64, 30, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(64, 18); g.lineTo(64, 38);
      g.moveTo(64, 90); g.lineTo(64, 110);
      g.moveTo(18, 64); g.lineTo(38, 64);
      g.moveTo(90, 64); g.lineTo(110, 64);
      g.stroke();
      g.beginPath();
      g.arc(64, 64, 5, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case "shield": {
      // Classic shield: broad top, tapering to a point at the bottom.
      g.beginPath();
      g.moveTo(32, 34);
      g.quadraticCurveTo(64, 24, 96, 34);
      g.lineTo(96, 64);
      g.quadraticCurveTo(96, 92, 64, 106);
      g.quadraticCurveTo(32, 92, 32, 64);
      g.closePath();
      g.stroke();
      break;
    }
    case "cargo": {
      // Crate: square with an X brace.
      g.strokeRect(34, 34, 60, 60);
      g.beginPath();
      g.moveTo(34, 34); g.lineTo(94, 94);
      g.moveTo(94, 34); g.lineTo(34, 94);
      g.stroke();
      break;
    }
    case "crew": {
      // Person: circular head above a shoulders arc.
      g.beginPath();
      g.arc(64, 44, 16, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(64, 104, 34, Math.PI, Math.PI * 2);
      g.stroke();
      break;
    }
    case "structure": {
      // Fairing brace: outer frame with a diagonal strut (shape-only hull padding).
      g.strokeRect(30, 30, 68, 68);
      g.beginPath();
      g.moveTo(30, 98); g.lineTo(98, 30);
      g.moveTo(42, 42); g.lineTo(86, 86);
      g.stroke();
      break;
    }
  }
}
function makeIconTexture(type: ModuleType, size: ModuleSize): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;

  // Background = the module type's color (so unlit/exterior views still read by hue).
  g.fillStyle = SPECS[type].color;
  g.fillRect(0, 0, 128, 128);

  // Soft dark backing keeps the white glyph legible on light tiles (crew/fuel/reactor).
  g.shadowColor = "rgba(0,0,0,0.45)";
  g.shadowBlur = 6;
  g.shadowOffsetX = 2;
  g.shadowOffsetY = 2;
  drawGlyph(g, type);

  // Size label, small, bottom-right corner.
  g.font = "bold 30px sans-serif";
  g.textAlign = "right";
  g.textBaseline = "alphabetic";
  g.fillStyle = "#ffffff";
  g.fillText(size, 122, 122);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawStructureShapeGlyph(g: CanvasRenderingContext2D, shape: StructureShape): void {
  g.strokeStyle = "#ffffff";
  g.fillStyle = "#ffffff";
  g.lineWidth = 8;
  g.lineJoin = "round";
  g.lineCap = "round";
  switch (shape) {
    case "block":
      g.strokeRect(34, 34, 60, 60);
      break;
    case "cone":
      g.beginPath();
      g.moveTo(64, 22);
      g.lineTo(98, 100);
      g.lineTo(30, 100);
      g.closePath();
      g.stroke();
      break;
    case "wedge":
      g.beginPath();
      g.moveTo(28, 96);
      g.lineTo(100, 96);
      g.lineTo(64, 28);
      g.closePath();
      g.stroke();
      break;
    case "dome":
      g.beginPath();
      g.arc(64, 64, 34, 0, Math.PI * 2);
      g.stroke();
      break;
    case "semi":
      g.beginPath();
      g.arc(64, 78, 36, Math.PI, 0);
      g.lineTo(100, 78);
      g.stroke();
      break;
  }
}

function makeStructureShapeIcon(shape: StructureShape): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = SPECS.structure.color;
  g.fillRect(0, 0, 128, 128);
  g.shadowColor = "rgba(0,0,0,0.45)";
  g.shadowBlur = 6;
  g.shadowOffsetX = 2;
  g.shadowOffsetY = 2;
  drawStructureShapeGlyph(g, shape);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Preview / internal mesh for a structure fairing, sized to the footprint. */
function buildStructureGeometry(shape: StructureShape, dx: number, dy: number, dz: number): THREE.BufferGeometry {
  const sx = dx * CELL * 0.86;
  const sy = dy * CELL * 0.86;
  const sz = dz * CELL * 0.86;
  switch (shape) {
    case "block":
      return new THREE.BoxGeometry(sx, sy, sz);
    case "cone": {
      const g = new THREE.ConeGeometry(Math.max(sx, sy) * 0.5, sz, 20);
      g.rotateX(-Math.PI / 2); // tip toward -Z (nose)
      return g;
    }
    case "wedge": {
      const sh = new THREE.Shape();
      sh.moveTo(-sx / 2, -sy / 2);
      sh.lineTo(sx / 2, -sy / 2);
      sh.lineTo(0, sy / 2);
      sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: sz, bevelEnabled: false, curveSegments: 1 });
      g.translate(0, 0, -sz / 2);
      return g;
    }
    case "dome": {
      const g = new THREE.SphereGeometry(1, 22, 16);
      g.scale(sx / 2, sy / 2, sz / 2);
      return g;
    }
    case "semi": {
      // Upper hemisphere in +Y, flat on the equator.
      const g = new THREE.SphereGeometry(1, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(sx / 2, sy, sz / 2);
      g.translate(0, -sy / 2, 0); // sit flat on the cell floor
      return g;
    }
  }
}

function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas, renderer } = ctx;

  const prevBackground = scene.background;
  const prevFog = scene.fog;
  const prevEnvironment = scene.environment;
  scene.background = new THREE.Color("#0a0d14");
  // The shared scene carries a default near-range fog (far 30) sized for the
  // small demo scenes — this editor's camera orbits at ~50+ units, which
  // would put the whole ship past the fog's far plane. No fog wanted in an editor.
  scene.fog = null;
  // Editor scene: OrbitControls orbit on an empty-space drag; a drag that starts on a
  // block instead moves that block (controls are disabled for that pointer, see below).
  controls.enabled = true;

  // ---- persistent resources (created once, disposed once at teardown) -------------
  const root = new THREE.Group();
  scene.add(root);

  // Soft ambient + key light; env map carries most of the "sleek metal" specular.
  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
  dirLight.position.set(20, 30, 10);
  const fillLight = new THREE.DirectionalLight(0xa8c4ff, 0.35);
  fillLight.position.set(-18, 8, -12);
  scene.add(ambient, dirLight, fillLight);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;

  // One box geometry per FOOTPRINT DIMS triple (dims, not size, because rotation gives a
  // module a footprint its size's default doesn't have), shared across every module of
  // those dims. Disposed at teardown; modules only own/dispose their material.
  const moduleGeomCache = new Map<string, THREE.BufferGeometry>();
  const dimsKey = (dx: number, dy: number, dz: number): string => `${dx}x${dy}x${dz}`;
  function moduleGeometryFor(dx: number, dy: number, dz: number): THREE.BufferGeometry {
    const key = dimsKey(dx, dy, dz);
    let g = moduleGeomCache.get(key);
    if (!g) {
      g = new THREE.BoxGeometry(dx * CELL * 0.86, dy * CELL * 0.86, dz * CELL * 0.86);
      moduleGeomCache.set(key, g);
    }
    return g;
  }
  // Structure fairing meshes are per (shape, dims) — cones/domes don't share the box cache.
  const structureGeomCache = new Map<string, THREE.BufferGeometry>();
  function structureGeometryFor(shape: StructureShape, dx: number, dy: number, dz: number): THREE.BufferGeometry {
    const key = `${shape}:${dimsKey(dx, dy, dz)}`;
    let g = structureGeomCache.get(key);
    if (!g) {
      g = buildStructureGeometry(shape, dx, dy, dz);
      structureGeomCache.set(key, g);
    }
    return g;
  }

  // 8 types x 4 sizes = 32 icon textures, generated once and disposed at teardown.
  const iconTextures = new Map<string, THREE.CanvasTexture>();
  const iconKey = (type: ModuleType, size: ModuleSize): string => `${type}:${size}`;
  for (const type of MODULE_TYPES) {
    for (const size of MODULE_SIZES) {
      iconTextures.set(iconKey(type, size), makeIconTexture(type, size));
    }
  }
  const structureShapeIcons = new Map<StructureShape, THREE.CanvasTexture>();
  for (const shape of STRUCTURE_SHAPES) {
    structureShapeIcons.set(shape, makeStructureShapeIcon(shape));
  }
  // Data-URL of an icon's baked canvas, so a DOM button can wear the exact same tile.
  const iconDataURL = (type: ModuleType, size: ModuleSize): string =>
    (iconTextures.get(iconKey(type, size))!.image as HTMLCanvasElement).toDataURL();
  const structureShapeDataURL = (shape: StructureShape): string =>
    (structureShapeIcons.get(shape)!.image as HTMLCanvasElement).toDataURL();

  // Subtle panel lines — same canvas bake path as module icons — keep the shell from
  // reading as a featureless balloon once clearcoat + env reflections kick in.
  const hullPanelMap = (() => {
    const canvasEl = document.createElement("canvas");
    canvasEl.width = 256;
    canvasEl.height = 256;
    const g = canvasEl.getContext("2d") as CanvasRenderingContext2D;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = "rgba(0,0,0,0.18)";
    g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      const p = (i / 8) * 256;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(256, p); g.stroke();
    }
    g.strokeStyle = "rgba(0,0,0,0.08)";
    g.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const p = (i + 0.5) / 8 * 256;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
    }
    const tex = new THREE.CanvasTexture(canvasEl);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 2);
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  })();

  const hullMaterial = new THREE.MeshPhysicalMaterial({
    color: "#5a6b8c",
    metalness: 0.85,
    roughness: 0.28,
    clearcoat: 1.0,
    clearcoatRoughness: 0.18,
    envMap,
    envMapIntensity: 1.15,
    roughnessMap: hullPanelMap,
  });
  const nozzleMaterial = new THREE.MeshStandardMaterial({ color: "#2b2f38", metalness: 0.5, roughness: 0.5, envMap, envMapIntensity: 0.6 });

  const moduleGroup = new THREE.Group();
  const hullGroup = new THREE.Group();
  root.add(moduleGroup, hullGroup);

  // ---- mutable layout state ---------------------------------------------------------
  const modules: Module[] = [];
  const offending = new Set<Module>(); // modules that break a rule; get the red tint.
  let selected: Module | null = null;
  const meshToModule = new Map<THREE.Object3D, Module>();

  const state = {
    view: "internal" as ViewMode,
    prefab: "fighter" as PrefabName,
    paletteSize: "S" as ModuleSize,
    structureShape: "block" as StructureShape,
    hullColor: "#5a6b8c",
    hullStyle: "skinned" as HullStyle,
  };
  const readout = { status: "OK — layout valid" };
  const perf = {
    mass: 0, thrust: 0, speed: 0, turn: 0,
    powerGen: 0, powerUse: 0, powerBalance: 0, heat: 0,
    shieldHP: 0, dps: 0, cargoCap: 0, fuelCap: 0, burn: 0, range: 0,
  };

  const round1 = (v: number): number => Math.round(v * 10) / 10;

  // ---- geometry helpers -------------------------------------------------------------
  // Unbounded lattice: a cell's world position is simply its integer coord times CELL.
  const cellX = (x: number): number => x * CELL;
  const cellY = (y: number): number => y * CELL;
  const cellZ = (z: number): number => z * CELL;
  // World-space center of a footprint anchored at (x,y,z) with dims (dx,dy,dz).
  function footprintCenter(x: number, y: number, z: number, dx: number, dy: number, dz: number): THREE.Vector3 {
    return new THREE.Vector3(cellX(x + (dx - 1) / 2), cellY(y + (dy - 1) / 2), cellZ(z + (dz - 1) / 2));
  }
  function occupantAt(x: number, y: number, z: number, exclude: Module | null = null): Module | null {
    // Layouts are tiny (<40 modules, footprints <=8 cells) so a linear scan over
    // modules and their footprints is cheaper than maintaining a cell->module map.
    for (const m of modules) {
      if (m === exclude) continue;
      if (x >= m.x && x < m.x + m.dx && y >= m.y && y < m.y + m.dy && z >= m.z && z < m.z + m.dz) return m;
    }
    return null;
  }
  // Connectivity: two modules are connected if ANY cell of one is orthogonally adjacent
  // to ANY cell of the other. Scan every footprint cell's six neighbors.
  function neighbors(m: Module): Module[] {
    const found = new Set<Module>();
    for (let ix = m.x; ix < m.x + m.dx; ix++) {
      for (let iy = m.y; iy < m.y + m.dy; iy++) {
        for (let iz = m.z; iz < m.z + m.dz; iz++) {
          for (const [dx, dy, dz] of DIRS) {
            const n = occupantAt(ix + dx, iy + dy, iz + dz);
            if (n && n !== m) found.add(n);
          }
        }
      }
    }
    return [...found];
  }

  // ---- footprint predicates (used by placement + validation) ------------------------
  // Every footprint cell is free (ignoring `exclude`, the module being moved).
  function footprintFree(x: number, y: number, z: number, dx: number, dy: number, dz: number, exclude: Module | null): boolean {
    for (let ix = x; ix < x + dx; ix++) {
      for (let iy = y; iy < y + dy; iy++) {
        for (let iz = z; iz < z + dz; iz++) {
          if (occupantAt(ix, iy, iz, exclude)) return false;
        }
      }
    }
    return true;
  }
  // At least one footprint cell is orthogonally adjacent to another module's cell.
  function footprintHasNeighbor(x: number, y: number, z: number, dx: number, dy: number, dz: number, exclude: Module | null): boolean {
    for (let ix = x; ix < x + dx; ix++) {
      for (let iy = y; iy < y + dy; iy++) {
        for (let iz = z; iz < z + dz; iz++) {
          for (const [ddx, ddy, ddz] of DIRS) {
            const n = occupantAt(ix + ddx, iy + ddy, iz + ddz, exclude);
            if (n) return true;
          }
        }
      }
    }
    return false;
  }
  // Engine exhaust clearance: every REAR-face cell (the +z outermost layer of the
  // footprint) must have a FREE cell directly behind it (+z). Replaces v1's "rearmost
  // grid layer" rule — in unbounded space "rear" is local to the engine, not a wall.
  function engineRearClearAt(x: number, y: number, z: number, dx: number, dy: number, dz: number, exclude: Module | null): boolean {
    const behind = z + dz; // cell layer immediately behind the rear face
    for (let ix = x; ix < x + dx; ix++) {
      for (let iy = y; iy < y + dy; iy++) {
        if (occupantAt(ix, iy, behind, exclude)) return false;
      }
    }
    return true;
  }
  // External hardpoint: at least one footprint cell has at least one FREE orthogonal
  // neighbor (i.e. the weapon is not fully buried). A neighbor inside the footprint
  // itself doesn't count as free — it's internal.
  function weaponHardpointAt(x: number, y: number, z: number, dx: number, dy: number, dz: number, exclude: Module | null): boolean {
    for (let ix = x; ix < x + dx; ix++) {
      for (let iy = y; iy < y + dy; iy++) {
        for (let iz = z; iz < z + dz; iz++) {
          for (const [ddx, ddy, ddz] of DIRS) {
            const nx = ix + ddx, ny = iy + ddy, nz = iz + ddz;
            const inside = nx >= x && nx < x + dx && ny >= y && ny < y + dy && nz >= z && nz < z + dz;
            if (inside) continue;
            if (!occupantAt(nx, ny, nz, exclude)) return true;
          }
        }
      }
    }
    return false;
  }

  // ---- module lifecycle -------------------------------------------------------------
  function positionMeshAt(mesh: THREE.Object3D, x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    mesh.position.copy(footprintCenter(x, y, z, dx, dy, dz));
  }
  function positionModuleMesh(mesh: THREE.Object3D, m: Module): void {
    positionMeshAt(mesh, m.x, m.y, m.z, m.dx, m.dy, m.dz);
  }
  // Builds a module + its mesh WITHOUT registering it in the layout (used by the drag
  // preview, which floats a not-yet-committed block). addModuleAt() does the registering.
  function createModule(type: ModuleType, size: ModuleSize, x: number, y: number, z: number, shape?: StructureShape): Module {
    const [dx, dy, dz] = SIZE_DIMS[size];
    const resolvedShape: StructureShape = type === "structure" ? (shape ?? state.structureShape) : "block";
    // Base color WHITE so the icon texture's baked colors show true; restyle() drives the
    // per-state tints (invalid red / heat lerp / drag preview) as multiplies over it.
    const map = type === "structure"
      ? structureShapeIcons.get(resolvedShape) ?? null
      : iconTextures.get(iconKey(type, size)) ?? null;
    const material = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map,
      metalness: 0.2,
      roughness: 0.6,
    });
    const geo = type === "structure"
      ? structureGeometryFor(resolvedShape, dx, dy, dz)
      : moduleGeometryFor(dx, dy, dz);
    const mesh = new THREE.Mesh(geo, material);
    const m: Module = { type, size, shape: resolvedShape, x, y, z, dx, dy, dz, mesh, material };
    positionModuleMesh(mesh, m);
    return m;
  }
  function addModuleAt(type: ModuleType, size: ModuleSize, x: number, y: number, z: number, shape?: StructureShape): Module {
    const m = createModule(type, size, x, y, z, shape);
    moduleGroup.add(m.mesh);
    modules.push(m);
    meshToModule.set(m.mesh, m);
    return m;
  }
  function removeModule(m: Module): void {
    moduleGroup.remove(m.mesh);
    meshToModule.delete(m.mesh);
    m.material.dispose(); // shared geometry + shared texture are NOT disposed here.
    const i = modules.indexOf(m);
    if (i >= 0) modules.splice(i, 1);
    if (selected === m) selected = null;
  }
  function clearModules(): void {
    for (const m of modules) {
      moduleGroup.remove(m.mesh);
      m.material.dispose();
    }
    modules.length = 0;
    meshToModule.clear();
    selected = null;
  }
  function setModulePos(m: Module, x: number, y: number, z: number): void {
    m.x = x;
    m.y = y;
    m.z = z;
    positionModuleMesh(m.mesh, m);
  }
  // Rotation reorients the footprint around the preserved anchor by swapping two of its
  // dims: "yaw" (vertical axis) swaps dx<->dz, "pitch" (lateral axis) swaps dy<->dz — so an
  // M block (1x1x2) can stand upright (1x2x1). The mesh just swaps to the matching cached
  // geometry; icon texture is unaffected. If the rotated footprint collides or breaks a
  // rule we DON'T block it — validation flags it red and the user drags it somewhere valid.
  function rotateModule(m: Module, axis: "yaw" | "pitch"): void {
    if (axis === "yaw") {
      const n = m.dz; m.dz = m.dx; m.dx = n;
    } else {
      const n = m.dz; m.dz = m.dy; m.dy = n;
    }
    m.mesh.geometry = m.type === "structure"
      ? structureGeometryFor(m.shape, m.dx, m.dy, m.dz)
      : moduleGeometryFor(m.dx, m.dy, m.dz);
    positionModuleMesh(m.mesh, m);
  }

  // ---- placement anchors (repair + duplicate) ---------------------------------------
  // Bounding box of every occupied cell (null when the ship is empty).
  function structureBounds(): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null {
    if (modules.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const m of modules) {
      minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x + m.dx - 1);
      minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y + m.dy - 1);
      minZ = Math.min(minZ, m.z); maxZ = Math.max(maxZ, m.z + m.dz - 1);
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }
  // Valid anchors for a (type, dims) footprint, enumerated from the free cells around the
  // existing structure: scan the structure's bounding box grown by the footprint on each
  // side, keep anchors whose footprint fits free, touches the structure, and satisfies the
  // per-type positional rule. `exclude` (the module being relocated) is treated as free.
  function validAnchorsFor(type: ModuleType, dx: number, dy: number, dz: number, exclude: Module | null): Cell[] {
    const b = structureBounds();
    const out: Cell[] = [];
    if (!b) return out; // empty ship — callers handle the origin drop themselves.
    for (let x = b.minX - dx; x <= b.maxX + 1; x++) {
      for (let y = b.minY - dy; y <= b.maxY + 1; y++) {
        for (let z = b.minZ - dz; z <= b.maxZ + 1; z++) {
          if (!footprintFree(x, y, z, dx, dy, dz, exclude)) continue;
          if (!footprintHasNeighbor(x, y, z, dx, dy, dz, exclude)) continue;
          if (type === "engine" && !engineRearClearAt(x, y, z, dx, dy, dz, exclude)) continue;
          if (type === "weapon" && !weaponHardpointAt(x, y, z, dx, dy, dz, exclude)) continue;
          out.push({ x, y, z });
        }
      }
    }
    return out;
  }
  // Nearest anchor to a reference cell (nearest-first == searching the ring outward).
  function nearestAnchor(anchors: Cell[], rx: number, ry: number, rz: number): Cell | null {
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const a of anchors) {
      const dd = Math.abs(a.x - rx) + Math.abs(a.y - ry) + Math.abs(a.z - rz);
      if (dd < bestD) {
        bestD = dd;
        best = a;
      }
    }
    return best;
  }

  // ---- connectivity + validation ----------------------------------------------------
  function largestComponent(): Set<Module> {
    const visited = new Set<Module>();
    let best = new Set<Module>();
    for (const start of modules) {
      if (visited.has(start)) continue;
      const comp = new Set<Module>();
      const stack = [start];
      visited.add(start);
      while (stack.length) {
        const m = stack.pop() as Module;
        comp.add(m);
        for (const n of neighbors(m)) {
          if (!visited.has(n)) {
            visited.add(n);
            stack.push(n);
          }
        }
      }
      if (comp.size > best.size) best = comp;
    }
    return best;
  }

  function recomputeStats(): void {
    // Mass and all CONSUMPTION stats (power draw, heat, fuel burn) scale by cell count
    // alone. All OUTPUT stats (power gen, thrust, dps, shield, cargo, fuel cap) scale by
    // cells × the size-efficiency multiplier — bigger blocks give more output per mass.
    let mass = 0, thrust = 0, powerGen = 0, powerUse = 0, heat = 0;
    let shieldHP = 0, dps = 0, cargoCap = 0, fuelCap = 0, burn = 0;
    for (const m of modules) {
      const s = SPECS[m.type];
      const cells = m.dx * m.dy * m.dz;
      const eff = SIZE_EFFICIENCY[m.size];
      const out = cells * eff;
      mass += s.mass * cells;
      thrust += s.thrust * out;
      if (s.power > 0) powerGen += s.power * out;
      else powerUse += -s.power * cells;
      heat += s.heat * cells;
      shieldHP += s.shieldHP * out;
      dps += s.dps * out;
      cargoCap += s.cargoCap * out;
      fuelCap += s.fuelCap * out;
      burn += s.fuelBurn * cells;
    }
    perf.mass = round1(mass);
    perf.thrust = round1(thrust);
    perf.speed = mass > 0 ? round1((thrust / mass) * 40) : 0;
    perf.turn = mass > 0 ? round1((thrust / mass) * 60) : 0;
    perf.powerGen = round1(powerGen);
    perf.powerUse = round1(powerUse);
    perf.powerBalance = round1(powerGen - powerUse);
    perf.heat = round1(heat);
    perf.shieldHP = round1(shieldHP);
    perf.dps = round1(dps);
    perf.cargoCap = round1(cargoCap);
    perf.fuelCap = round1(fuelCap);
    perf.burn = round1(burn);
    perf.range = burn > 0 ? Math.round((fuelCap / burn) * perf.speed) : 0;
  }

  function validate(): void {
    offending.clear();
    const issues: string[] = [];

    const reactors = modules.filter((m) => m.type === "reactor").length;
    const engines = modules.filter((m) => m.type === "engine").length;
    const crews = modules.filter((m) => m.type === "crew").length;
    if (reactors === 0) issues.push("no reactor");
    if (engines === 0) issues.push("no engine");
    if (crews === 0) issues.push("no crew");

    if (perf.powerBalance < 0) issues.push("power deficit");

    // Rule: every engine needs clear space directly behind its rear face (exhaust).
    const blocked = modules.filter((m) => m.type === "engine" && !engineRearClearAt(m.x, m.y, m.z, m.dx, m.dy, m.dz, null));
    for (const m of blocked) offending.add(m);
    if (blocked.length > 0) issues.push(`${blocked.length > 1 ? `${blocked.length} engines` : "engine"} exhaust blocked`);

    // Rule: every weapon must have a free neighbor (an external hardpoint, not buried).
    const buried = modules.filter((m) => m.type === "weapon" && !weaponHardpointAt(m.x, m.y, m.z, m.dx, m.dy, m.dz, null));
    for (const m of buried) offending.add(m);
    if (buried.length > 0) issues.push(`${buried.length > 1 ? `${buried.length} weapons` : "weapon"} buried`);

    // Rule: everything must form one connected component; islands are unpowered.
    const largest = largestComponent();
    const disconnected = modules.filter((m) => !largest.has(m));
    for (const m of disconnected) offending.add(m);
    if (disconnected.length > 0) issues.push(`${disconnected.length} module${disconnected.length > 1 ? "s" : ""} disconnected`);

    readout.status = issues.length === 0
      ? "OK — layout valid"
      : `${issues.length} issue${issues.length > 1 ? "s" : ""}: ${issues.join("; ")}`;
  }

  function selectionLabel(m: Module): string {
    const cells = m.dx * m.dy * m.dz;
    const shapeBit = m.type === "structure" ? ` ${STRUCTURE_SHAPE_LABEL[m.shape]}` : "";
    return `${m.type}${shapeBit} ${m.size} · ${cells} cell${cells > 1 ? "s" : ""}`;
  }

  // ---- visual styling ---------------------------------------------------------------
  function restyle(): void {
    for (const m of modules) {
      // Emissive uses the type color for selection/baseline self-glow; the diffuse base
      // stays white so the icon texture reads true (tints multiply over it).
      const glow = SPECS[m.type].color;
      m.material.color.set("#ffffff");
      if (state.view === "performance") {
        // Glanceable "where does the heat come from" view: lerp toward red,
        // normalized by the HOTTEST module type on board (not total ship
        // heat, which capped every lerp at ~25% and made the view nearly
        // indistinguishable from the internal one).
        let maxHeat = 1;
        for (const other of modules) maxHeat = Math.max(maxHeat, SPECS[other.type].heat);
        m.material.color.lerp(RED, SPECS[m.type].heat / maxHeat);
      }
      const invalid = offending.has(m);
      const isSel = m === selected;
      if (invalid) {
        // Tint the diffuse toward red so a rule-breaking block reads at a glance, on
        // top of the red emissive.
        m.material.color.copy(RED);
        m.material.emissive.set("#ff2a2a");
        m.material.emissiveIntensity = 0.7;
      } else if (isSel) {
        m.material.emissive.set(glow);
        m.material.emissiveIntensity = 0.9;
      } else {
        // Baseline self-glow so module colors stay readable against the
        // near-black background — lit-only shading left them too dark to
        // tell types apart on a phone screen.
        m.material.emissive.set(glow);
        m.material.emissiveIntensity = 0.35;
      }
      m.mesh.scale.setScalar(isSel ? 1.12 : 1);
    }
  }
  // While dragging, the dragged mesh IS the preview: green-ish when the placement is
  // valid, red-ish when it collides. Overrides restyle() until the drag commits/aborts.
  function applyDragTint(m: Module, valid: boolean): void {
    m.material.color.set("#ffffff");
    m.material.emissive.set(valid ? "#43f08a" : "#ff3b3b");
    m.material.emissiveIntensity = 0.9;
    m.mesh.scale.setScalar(1.12);
  }
  // Unsnapped "carrying" tint: a dim blue self-glow, distinct from green (placeable) and
  // red (colliding) — it just means the block is riding the finger in free space.
  function applyFloatTint(m: Module): void {
    m.material.color.set("#ffffff");
    m.material.emissive.set("#4da3ff");
    m.material.emissiveIntensity = 0.5;
    m.mesh.scale.setScalar(1.12);
  }

  // ---- generated exterior hull ------------------------------------------------------
  function disposeHullMeshes(): void {
    // Styles may share geometries across meshes (nozzles) — collect into a set first
    // so nothing gets double-disposed.
    const geometries = new Set<THREE.BufferGeometry>();
    for (const child of hullGroup.children) {
      if (child instanceof THREE.Mesh) geometries.add(child.geometry);
    }
    for (const g of geometries) g.dispose();
    hullGroup.clear();
  }
  function addEngineNozzles(rearPlaneZFor: (m: Module) => number): void {
    // One nozzle per engine footprint cell on the engine's rear face — an XL engine
    // (2x2 rear layer) gets a 2x2 nozzle cluster. The hull visibly reflects the
    // propulsion layout, whichever style is on.
    const nozzleLen = 0.9 * CELL;
    const nozzleGeometry = new THREE.CylinderGeometry(0.35 * CELL, 0.35 * CELL, nozzleLen, 12);
    for (const m of modules) {
      if (m.type !== "engine") continue;
      const rz = rearPlaneZFor(m);
      for (let ix = m.x; ix < m.x + m.dx; ix++) {
        for (let iy = m.y; iy < m.y + m.dy; iy++) {
          const nozzle = new THREE.Mesh(nozzleGeometry, nozzleMaterial);
          nozzle.rotation.x = Math.PI / 2; // align cylinder's y axis with +z
          nozzle.position.set(cellX(ix), cellY(iy), rz + nozzleLen / 2 - 0.1);
          hullGroup.add(nozzle);
        }
      }
    }
  }
  function buildHull(): void {
    disposeHullMeshes();
    if (modules.length === 0) return;
    if (state.hullStyle === "skinned") buildSkinnedHull();
    else if (state.hullStyle === "plated") buildPlatedHull();
    else buildBoxHull();
  }

  // SDF smooth-union of module primitives → marching cubes. Structure shapes (cone,
  // wedge, dome, …) become matching SDF prims so fairings sculpt the skinned shell.
  function buildSkinnedHull(): void {
    const prims: HullPrimitive[] = [];
    const skin = 0.22 * CELL;
    const round = 0.38 * CELL;
    for (const m of modules) {
      const c = footprintCenter(m.x, m.y, m.z, m.dx, m.dy, m.dz);
      const hx = (m.dx * CELL) / 2 + skin;
      const hy = (m.dy * CELL) / 2 + skin;
      const hz = (m.dz * CELL) / 2 + skin;
      if (m.type !== "structure" || m.shape === "block") {
        prims.push({ kind: "box", cx: c.x, cy: c.y, cz: c.z, hx, hy, hz, radius: round });
      } else if (m.shape === "cone") {
        prims.push({ kind: "cone", cx: c.x, cy: c.y, cz: c.z, hx, hy, hz });
      } else if (m.shape === "wedge") {
        prims.push({ kind: "wedge", cx: c.x, cy: c.y, cz: c.z, hx, hy, hz });
      } else if (m.shape === "dome") {
        prims.push({ kind: "dome", cx: c.x, cy: c.y, cz: c.z, hx, hy, hz });
      } else {
        prims.push({ kind: "semi", cx: c.x, cy: c.y, cz: c.z, hx, hy, hz });
      }
    }
    const geo = buildSdfHullGeometry(prims, {
      smoothK: 1.25 * CELL * 0.35,
      samplesPerCell: 3.5,
      cellSize: CELL,
      pad: CELL * 1.1,
    });
    if (geo) hullGroup.add(new THREE.Mesh(geo, hullMaterial));
    addEngineNozzles((m) => cellZ(m.z + m.dz - 1) + CELL / 2 + skin);
  }

  // Lofted fuselage (kept as a lighter alternative): Catmull-Rom profiles + ogive nose.
  // Still one body per Z — asymmetric nacelles belong on "skinned".
  function buildPlatedHull(): void {
    type Layer = { z: number; cx: number; cy: number; rx: number; ry: number };
    const byZ = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>();
    for (const m of modules) {
      for (let ix = m.x; ix < m.x + m.dx; ix++) {
        for (let iy = m.y; iy < m.y + m.dy; iy++) {
          for (let iz = m.z; iz < m.z + m.dz; iz++) {
            const s = byZ.get(iz);
            if (!s) byZ.set(iz, { minX: ix, maxX: ix, minY: iy, maxY: iy });
            else {
              s.minX = Math.min(s.minX, ix); s.maxX = Math.max(s.maxX, ix);
              s.minY = Math.min(s.minY, iy); s.maxY = Math.max(s.maxY, iy);
            }
          }
        }
      }
    }
    const pad = 0.45 * CELL;
    const layers: Layer[] = [...byZ.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([iz, s]) => ({
        z: cellZ(iz),
        cx: cellX((s.minX + s.maxX) / 2),
        cy: cellY((s.minY + s.maxY) / 2),
        rx: ((s.maxX - s.minX + 1) * CELL) / 2 + pad,
        ry: ((s.maxY - s.minY + 1) * CELL) / 2 + pad,
      }));
    if (layers.length === 0) return;

    const catmull = (p0: number, p1: number, p2: number, p3: number, t: number): number =>
      0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

    const sampleLayer = (wz: number): Layer => {
      if (layers.length === 1) return { ...layers[0], z: wz };
      // Find segment; extrapolate with endpoint clones for Catmull-Rom.
      let i = 0;
      while (i < layers.length - 2 && wz > layers[i + 1].z) i++;
      const l0 = layers[Math.max(0, i - 1)];
      const l1 = layers[i];
      const l2 = layers[Math.min(layers.length - 1, i + 1)];
      const l3 = layers[Math.min(layers.length - 1, i + 2)];
      const span = Math.max(1e-6, l2.z - l1.z);
      const t = THREE.MathUtils.clamp((wz - l1.z) / span, 0, 1);
      // Smoothstep the parameter so segment joins stay C1-ish.
      const ts = t * t * (3 - 2 * t);
      return {
        z: wz,
        cx: catmull(l0.cx, l1.cx, l2.cx, l3.cx, ts),
        cy: catmull(l0.cy, l1.cy, l2.cy, l3.cy, ts),
        rx: Math.max(pad * 0.35, catmull(l0.rx, l1.rx, l2.rx, l3.rx, ts)),
        ry: Math.max(pad * 0.3, catmull(l0.ry, l1.ry, l2.ry, l3.ry, ts)),
      };
    };

    const segs = 48;
    const z0 = layers[0].z;
    const z1 = layers[layers.length - 1].z;
    const noseLen = 2.0 * CELL;
    const sternLen = 0.7 * CELL;
    const noseZ = z0 - noseLen;
    const sternZ = z1 + sternLen;
    const samples = Math.max(24, Math.ceil(((sternZ - noseZ) / CELL) * 8));

    const profileAt = (wz: number): Layer & { n: number } => {
      const L = sampleLayer(THREE.MathUtils.clamp(wz, z0, z1));
      // Ogive nose: circular-arc radius shrink over ~2 cells past the front.
      let taper = 1;
      if (wz < z0) {
        const t = THREE.MathUtils.clamp(1 - (z0 - wz) / noseLen, 0, 1);
        taper = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))); // ogive
      } else if (wz > z1) {
        const t = THREE.MathUtils.clamp(1 - (wz - z1) / sternLen, 0, 1);
        taper = THREE.MathUtils.smoothstep(t, 0, 1);
      }
      // Squarer near the stern (engine blocks), rounder toward the nose.
      const along = THREE.MathUtils.clamp((wz - noseZ) / Math.max(1e-6, sternZ - noseZ), 0, 1);
      const n = THREE.MathUtils.lerp(2.05, 3.2, along * along);
      return {
        z: wz,
        cx: L.cx,
        cy: L.cy,
        rx: Math.max(pad * 0.2, L.rx * taper),
        ry: Math.max(pad * 0.16, L.ry * taper),
        n,
      };
    };

    const positions: number[] = [];
    const indices: number[] = [];
    const rings: (Layer & { n: number })[] = [];
    for (let i = 0; i <= samples; i++) {
      const wz = noseZ + (sternZ - noseZ) * (i / samples);
      const R = profileAt(wz);
      rings.push(R);
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const sx = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / R.n);
        const sy = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / R.n);
        positions.push(R.cx + R.rx * sx, R.cy + R.ry * sy, wz);
      }
    }

    for (let i = 0; i < samples; i++) {
      for (let s = 0; s < segs; s++) {
        const s2 = (s + 1) % segs;
        const a = i * segs + s;
        const b = i * segs + s2;
        const c = (i + 1) * segs + s;
        const d = (i + 1) * segs + s2;
        indices.push(a, b, c, b, d, c);
      }
    }

    const noseTip = positions.length / 3;
    positions.push(rings[0].cx, rings[0].cy, noseZ - CELL * 0.08);
    const sternTip = positions.length / 3;
    positions.push(rings[samples].cx, rings[samples].cy, sternZ + CELL * 0.08);
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs;
      indices.push(noseTip, s, s2);
      const a = samples * segs + s;
      const b = samples * segs + s2;
      indices.push(sternTip, b, a);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    hullGroup.add(new THREE.Mesh(geo, hullMaterial));

    addEngineNozzles((m) => cellZ(m.z + m.dz - 1) + CELL / 2 + pad * 0.5);
  }
  // The original single-shell alternative, kept for comparison: an inflated
  // box over the installed modules' bounding volume with a cone nose.
  function buildBoxHull(): void {
    // Bounding box of the INSTALLED modules' footprints — this is why the hull visibly
    // re-fits when modules are added, moved or removed.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const m of modules) {
      const loX = cellX(m.x), hiX = cellX(m.x + m.dx - 1);
      const loY = cellY(m.y), hiY = cellY(m.y + m.dy - 1);
      const loZ = cellZ(m.z), hiZ = cellZ(m.z + m.dz - 1);
      minX = Math.min(minX, loX); maxX = Math.max(maxX, hiX);
      minY = Math.min(minY, loY); maxY = Math.max(maxY, hiY);
      minZ = Math.min(minZ, loZ); maxZ = Math.max(maxZ, hiZ);
    }
    const margin = 0.8 * CELL;
    const sx = (maxX - minX) + 2 * margin;
    const sy = ((maxY - minY) + 2 * margin) * 0.85; // slight vertical squash
    const sz = (maxZ - minZ) + 2 * margin;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const body = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), hullMaterial);
    body.position.set(cx, cy, cz);
    hullGroup.add(body);

    // 4-sided cone nose on the front (-z) face.
    const noseLen = 1.6 * CELL;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(Math.max(sx, sy) * 0.42, noseLen, 4), hullMaterial);
    nose.rotation.x = -Math.PI / 2; // point the cone's +y axis toward -z
    nose.position.set(cx, cy, cz - sz / 2 - noseLen / 2);
    hullGroup.add(nose);

    const rearZ = cz + sz / 2;
    addEngineNozzles(() => rearZ);
  }

  // ---- view + camera ----------------------------------------------------------------
  function applyView(): void {
    const internalLike = state.view !== "exterior";
    moduleGroup.visible = internalLike;
    hullGroup.visible = state.view === "exterior";
    if (state.view === "exterior") buildHull();
    if (state.view === "performance") perfFolder.open();
    else perfFolder.close();
    restyle();
    updateBars();
  }
  function frameCamera(): void {
    // Frame the layout's bounding sphere: target its center, sit back by its diagonal.
    const b = structureBounds();
    const target = new THREE.Vector3();
    let diag = CELL * 4;
    if (b) {
      const minWX = cellX(b.minX) - CELL / 2, maxWX = cellX(b.maxX) + CELL / 2;
      const minWY = cellY(b.minY) - CELL / 2, maxWY = cellY(b.maxY) + CELL / 2;
      const minWZ = cellZ(b.minZ) - CELL / 2, maxWZ = cellZ(b.maxZ) + CELL / 2;
      target.set((minWX + maxWX) / 2, (minWY + maxWY) / 2, (minWZ + maxWZ) / 2);
      diag = Math.hypot(maxWX - minWX, maxWY - minWY, maxWZ - minWZ);
    }
    controls.target.copy(target);
    // A portrait phone's horizontal FOV is the binding constraint here
    // (~27° at 55° vertical on a 390x844 viewport), so the camera has to sit
    // much farther back than the vertical FOV alone would suggest — at the
    // "obvious" ~1.3x diag distance the layout overflows the screen sideways.
    camera.position.set(target.x + diag * 1.35, target.y + diag * 1.05, target.z + diag * 1.6);
    controls.update();
  }

  // Recompute everything downstream of a layout edit.
  function onLayoutChanged(): void {
    recomputeStats();
    validate();
    restyle();
    updateBars();
    if (state.view === "exterior") buildHull();
  }

  function loadPrefab(name: PrefabName): void {
    clearModules();
    const p = PREFABS[name];
    // Prefabs are all size "S" — their baked-in stats are regression baselines.
    for (const def of p.modules) addModuleAt(def.type, "S", def.x, def.y, def.z);
    // Translate the layout so its center of mass sits near the origin — unbounded space
    // has no natural center. Round the (cell-count-weighted) mean so cells stay integral.
    let sx = 0, sy = 0, sz = 0, tot = 0;
    for (const m of modules) {
      const c = m.dx * m.dy * m.dz;
      sx += (m.x + (m.dx - 1) / 2) * c;
      sy += (m.y + (m.dy - 1) / 2) * c;
      sz += (m.z + (m.dz - 1) / 2) * c;
      tot += c;
    }
    const ox = Math.round(sx / tot), oy = Math.round(sy / tot), oz = Math.round(sz / tot);
    for (const m of modules) setModulePos(m, m.x - ox, m.y - oy, m.z - oz);

    state.hullColor = p.hullColor;
    hullMaterial.color.set(p.hullColor);
    hullColorCtrl.updateDisplay();
    selected = null;
    onLayoutChanged();
    frameCamera();
    applyView();
  }

  // ---- duplicate + rotate + remove (selection actions) ------------------------------
  function duplicateSelected(): void {
    if (!selected) return;
    // Copy the selected module to the nearest valid free anchor adjacent to it (the ring
    // search fans outward from its own anchor). Duplicate keeps the current dims.
    const anchors = validAnchorsFor(selected.type, selected.dx, selected.dy, selected.dz, null);
    const dest = nearestAnchor(anchors, selected.x, selected.y, selected.z);
    if (!dest) {
      readout.status = "No room to duplicate — free up a face first";
      return;
    }
    const copy = addModuleAt(selected.type, selected.size, dest.x, dest.y, dest.z, selected.shape);
    // A duplicate of a rotated module should match its orientation.
    if (copy.dx !== selected.dx || copy.dz !== selected.dz) {
      copy.dx = selected.dx;
      copy.dz = selected.dz;
      copy.mesh.geometry = moduleGeometryFor(copy.dx, copy.dy, copy.dz);
      positionModuleMesh(copy.mesh, copy);
    }
    select(copy);
    onLayoutChanged();
  }
  function removeSelected(): void {
    if (!selected) return;
    removeModule(selected);
    select(null);
    onLayoutChanged();
  }
  function rotateSelected(axis: "yaw" | "pitch"): void {
    if (!selected) return;
    rotateModule(selected, axis);
    onLayoutChanged();
  }

  // ---- repair -----------------------------------------------------------------------
  function repair(): void {
    const done: string[] = [];

    // (a) Exhaust-blocked engines → nearest valid anchor (clearance behind, touches, fits).
    let enginesMoved = 0;
    for (const m of modules) {
      if (m.type !== "engine" || engineRearClearAt(m.x, m.y, m.z, m.dx, m.dy, m.dz, m)) continue;
      const dest = nearestAnchor(validAnchorsFor(m.type, m.dx, m.dy, m.dz, m), m.x, m.y, m.z);
      if (dest) {
        setModulePos(m, dest.x, dest.y, dest.z);
        enginesMoved++;
      }
    }
    if (enginesMoved > 0) done.push(`cleared ${enginesMoved} engine exhaust${enginesMoved > 1 ? "s" : ""}`);

    // (b) Buried weapons → nearest valid anchor (a free neighbor / hardpoint).
    let weaponsMoved = 0;
    for (const m of modules) {
      if (m.type !== "weapon" || weaponHardpointAt(m.x, m.y, m.z, m.dx, m.dy, m.dz, m)) continue;
      const dest = nearestAnchor(validAnchorsFor(m.type, m.dx, m.dy, m.dz, m), m.x, m.y, m.z);
      if (dest) {
        setModulePos(m, dest.x, dest.y, dest.z);
        weaponsMoved++;
      }
    }
    if (weaponsMoved > 0) done.push(`moved ${weaponsMoved} weapon${weaponsMoved > 1 ? "s" : ""} to a hardpoint`);

    // (c) Anything still off the main component gets scrapped.
    const largest = largestComponent();
    const orphans = modules.filter((m) => !largest.has(m));
    for (const m of orphans) removeModule(m);
    if (orphans.length > 0) done.push(`removed ${orphans.length} disconnected module${orphans.length > 1 ? "s" : ""}`);

    select(null);
    onLayoutChanged();

    let msg = done.length > 0 ? `Repaired: ${done.join("; ")}` : "Nothing to auto-repair";
    // Power is a design choice, not a placement bug — we don't invent reactors.
    if (perf.powerBalance < 0) msg += " — add a reactor or remove consumers";
    readout.status = msg;
  }

  // ---- drag-and-drop editing --------------------------------------------------------
  // ONE drag can be under way at a time. A module drag starts on a block on the canvas
  // (isNew=false); a palette drag starts on a palette button (isNew=true) and spawns its
  // module the first time the pointer crosses the canvas. Both share updateDragPreview().
  interface Drag {
    module: Module | null; // the mesh being moved/previewed (null until a palette spawn)
    isNew: boolean;        // spawned from the palette → discard on invalid release
    type: ModuleType;      // spawn descriptor (isNew only)
    size: ModuleSize;
    shape: StructureShape;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;        // crossed the 8px threshold → live drag (module drags only)
    candidate: Cell | null;
    valid: boolean;
  }
  const DRAG_PX = 8;
  let drag: Drag | null = null;
  // A tap on empty space (small movement, no block hit) deselects; a larger move orbited.
  let emptyTap: { pointerId: number; startX: number; startY: number } | null = null;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const worldNormal = new THREE.Vector3();
  const hitPoint = new THREE.Vector3();
  const scratchVec = new THREE.Vector3(); // reused for the floating-ghost ray point
  const dragTargets: THREE.Mesh[] = [];

  function raycastModules(clientX: number, clientY: number, exclude: Module | null): THREE.Intersection[] {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    dragTargets.length = 0;
    for (const m of modules) if (m !== exclude) dragTargets.push(m.mesh);
    return raycaster.intersectObjects(dragTargets, false);
  }

  function setDragCandidate(dg: Drag, x: number, y: number, z: number): void {
    const m = dg.module!;
    dg.candidate = { x, y, z };
    positionMeshAt(m.mesh, x, y, z, m.dx, m.dy, m.dz);
    // Preview validity is footprint-collision only (connectivity is guaranteed by the
    // face-attach; the per-type rule is deferred to post-drop validation).
    dg.valid = footprintFree(x, y, z, m.dx, m.dy, m.dz, m);
    applyDragTint(m, dg.valid);
    m.mesh.visible = true;
  }

  // No structure face under the pointer → the ghost has no snap candidate. Float its mesh
  // on the pointer ray at the camera-to-target distance so it visibly rides the finger,
  // wearing the neutral "carrying" tint. Unsnapped release discards (palette) / snaps back
  // (module), so we null the candidate here.
  function floatDragGhost(dg: Drag): void {
    const m = dg.module!;
    dg.candidate = null;
    raycaster.ray.at(camera.position.distanceTo(controls.target), scratchVec);
    m.mesh.position.copy(scratchVec);
    applyFloatTint(m);
    m.mesh.visible = true;
  }

  function updateDragPreview(dg: Drag, clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    const over = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    // A palette module is created on the first canvas hover (its mesh is the preview).
    if (dg.isNew && !dg.module) {
      if (!over) return;
      const m = createModule(dg.type, dg.size, 0, 0, 0, dg.shape);
      m.mesh.visible = false;
      moduleGroup.add(m.mesh);
      dg.module = m;
    }
    const m = dg.module;
    if (!m) return;
    if (!over) {
      // Off-canvas: keep the last candidate; if none yet, hide a fresh palette ghost.
      if (dg.candidate === null && dg.isNew) m.mesh.visible = false;
      return;
    }
    // Empty ship: nothing to attach to, so a (palette) module simply drops at the origin.
    if (modules.length === 0) {
      setDragCandidate(dg, 0, 0, 0);
      return;
    }
    const hits = raycastModules(clientX, clientY, m);
    const hit = hits[0];
    if (!hit || !hit.face) {
      // No block under the pointer → the ghost floats free on the ray (unsnapped).
      floatDragGhost(dg);
      return;
    }
    const hm = meshToModule.get(hit.object)!;
    // Attach anchor from the hit face's world normal, rounded to its dominant axis.
    worldNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    const ax = Math.abs(worldNormal.x), ay = Math.abs(worldNormal.y), az = Math.abs(worldNormal.z);
    let axis = 0, sign = 1;
    if (ax >= ay && ax >= az) { axis = 0; sign = worldNormal.x >= 0 ? 1 : -1; }
    else if (ay >= az) { axis = 1; sign = worldNormal.y >= 0 ? 1 : -1; }
    else { axis = 2; sign = worldNormal.z >= 0 ? 1 : -1; }
    // Which cell of the hit block owns this face: nudge the hit point inward along the
    // normal (the mesh is inset inside its cell), round to the lattice, clamp to hm.
    hitPoint.copy(hit.point);
    if (axis === 0) hitPoint.x -= sign * CELL * 0.5;
    else if (axis === 1) hitPoint.y -= sign * CELL * 0.5;
    else hitPoint.z -= sign * CELL * 0.5;
    const hcx = clampInt(Math.round(hitPoint.x / CELL), hm.x, hm.x + hm.dx - 1);
    const hcy = clampInt(Math.round(hitPoint.y / CELL), hm.y, hm.y + hm.dy - 1);
    const hcz = clampInt(Math.round(hitPoint.z / CELL), hm.z, hm.z + hm.dz - 1);
    // The dragged footprint sits adjacent to that cell along the normal; the other two
    // anchor axes align to the hit cell. For a NEGATIVE-axis normal the block extends back
    // toward -axis, so its anchor (min corner) is offset by the dragged dims on that axis.
    let nx = hcx, ny = hcy, nz = hcz;
    if (axis === 0) nx = sign > 0 ? hcx + 1 : hcx - m.dx;
    else if (axis === 1) ny = sign > 0 ? hcy + 1 : hcy - m.dy;
    else nz = sign > 0 ? hcz + 1 : hcz - m.dz;
    setDragCandidate(dg, nx, ny, nz);
  }

  // Commit or abort the in-flight drag. `commit` is honored only if the preview is valid.
  function finishDrag(commit: boolean): void {
    const dg = drag;
    drag = null;
    exitTrashMode(); // commit / snap-back / cancel all clear any trash styling
    if (!dg) return;
    const ok = commit && dg.candidate !== null && dg.valid;
    if (dg.isNew) {
      const m = dg.module;
      if (m && ok) {
        setModulePos(m, dg.candidate!.x, dg.candidate!.y, dg.candidate!.z);
        modules.push(m);
        meshToModule.set(m.mesh, m);
        select(m);
        onLayoutChanged();
      } else if (m) {
        // Discarded palette ghost — never entered the layout, dispose its material.
        moduleGroup.remove(m.mesh);
        m.material.dispose();
      }
    } else {
      const m = dg.module!;
      if (dg.moved && ok) {
        setModulePos(m, dg.candidate!.x, dg.candidate!.y, dg.candidate!.z);
        onLayoutChanged();
      } else {
        // Tap (never moved) or invalid drop: snap the mesh back to where it was.
        positionModuleMesh(m.mesh, m);
        restyle();
      }
    }
    updateBars();
  }

  // A live module drag released over the palette bar trashes the block — the same full
  // teardown as the Remove button (deselect, restat, revalidate), plus a status message.
  function removeDraggedModule(dg: Drag): void {
    const m = dg.module;
    if (!m) return;
    const label = `${m.type} ${m.size}`;
    removeModule(m);
    select(null);
    onLayoutChanged();
    readout.status = `removed ${label}`;
  }

  // pointerdown is captured at the DOCUMENT so it runs during the capturing phase — i.e.
  // BEFORE OrbitControls' own pointerdown listener on the canvas (which, being on the
  // target element, would otherwise fire first regardless of any capture flag). When the
  // press lands on a block we disable controls here so OrbitControls bails out and the
  // press moves the block; on empty space we leave controls enabled so it orbits. Both
  // palette-button drags and canvas move/up are also driven document-level (a palette
  // press never reaches the canvas, and a captured drag can wander off it).
  function onDocPointerDown(e: PointerEvent): void {
    if (state.view === "exterior" || drag) return; // exterior is a read-only preview.
    if (e.target !== canvas) return; // palette/GUI presses have their own handlers.
    const hits = raycastModules(e.clientX, e.clientY, null);
    const m = hits[0] ? meshToModule.get(hits[0].object) ?? null : null;
    if (m) {
      controls.enabled = false;
      select(m);
      drag = { module: m, isNew: false, type: m.type, size: m.size, shape: m.shape, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, candidate: null, valid: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    } else {
      emptyTap = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    }
  }
  function onDocPointerMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.isNew && !drag.moved) {
      // <8px before release is a tap (selection only); >=8px promotes to a live drag.
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_PX) return;
      drag.moved = true;
      enterTrashMode(); // module drag is now live → the palette becomes a trash target
    }
    updateDragPreview(drag, e.clientX, e.clientY);
    // Stronger red while the pointer is actually over the bar (module drags only).
    if (!drag.isNew && drag.moved) {
      paletteBar.classList.toggle("ship-palette--trash-hot", pointerInPalette(e.clientX, e.clientY));
    }
  }
  function endModuleDrag(e: PointerEvent): void {
    controls.enabled = true;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }
  function onDocPointerUp(e: PointerEvent): void {
    if (drag && e.pointerId === drag.pointerId) {
      const dg = drag;
      if (!dg.isNew) endModuleDrag(e);
      // Dropped on the palette bar: a live module drag trashes the block; a palette-spawned
      // ghost just discards quietly. Anything else takes the normal commit/snap-back path.
      if (pointerInPalette(e.clientX, e.clientY)) {
        if (!dg.isNew && dg.moved) {
          drag = null;
          exitTrashMode();
          removeDraggedModule(dg);
          updateBars();
          return;
        }
        if (dg.isNew) {
          finishDrag(false);
          return;
        }
      }
      finishDrag(true);
      return;
    }
    if (emptyTap && e.pointerId === emptyTap.pointerId) {
      const dist = Math.hypot(e.clientX - emptyTap.startX, e.clientY - emptyTap.startY);
      emptyTap = null;
      if (dist < DRAG_PX) select(null); // a tap on empty space deselects; a drag orbited
    }
  }
  function onDocPointerCancel(e: PointerEvent): void {
    if (drag && e.pointerId === drag.pointerId) {
      if (!drag.isNew) endModuleDrag(e);
      finishDrag(false);
    }
    if (emptyTap && e.pointerId === emptyTap.pointerId) emptyTap = null;
  }

  document.addEventListener("pointerdown", onDocPointerDown, { capture: true });
  document.addEventListener("pointermove", onDocPointerMove);
  document.addEventListener("pointerup", onDocPointerUp);
  document.addEventListener("pointercancel", onDocPointerCancel);

  // ---- touch UI: palette bar + selection action bar (DOM overlays) ------------------
  function select(m: Module | null): void {
    selected = m;
    restyle();
    updateBars();
  }

  // Palette: type icons (drag onto canvas) + size cycle. Structure fairing *shape* lives
  // on the second menu above this bar.
  const paletteBar = document.createElement("div");
  paletteBar.className = "ship-palette";
  const paletteButtons: { btn: HTMLButtonElement; type: ModuleType }[] = [];
  for (const type of MODULE_TYPES) {
    const btn = document.createElement("button");
    btn.className = "ship-pal-btn";
    btn.dataset.type = type;
    btn.setAttribute("aria-label", `add ${type}`);
    btn.addEventListener("pointerdown", (e) => onPaletteDown(e, type));
    paletteBar.appendChild(btn);
    paletteButtons.push({ btn, type });
  }
  const sizeBtn = document.createElement("button");
  sizeBtn.className = "ship-pal-size";
  sizeBtn.setAttribute("aria-label", "cycle module size");
  sizeBtn.addEventListener("click", () => {
    const i = (MODULE_SIZES.indexOf(state.paletteSize) + 1) % MODULE_SIZES.length;
    state.paletteSize = MODULE_SIZES[i];
    refreshPaletteIcons();
  });
  paletteBar.appendChild(sizeBtn);
  // Trash hint: shown (via .ship-palette--trash) only while a module drag is live, so the
  // bar reads as a "drop to remove" target. An overlaid child div is cleaner than juggling
  // ::after content, and it's a child of paletteBar so paletteBar.remove() disposes it too.
  const trashHint = document.createElement("div");
  trashHint.className = "ship-palette-trash-hint";
  trashHint.textContent = "Drop here to remove";
  paletteBar.appendChild(trashHint);
  document.body.appendChild(paletteBar);

  // Second menu: structure fairing shapes (block / cone / wedge / dome / semi). Selecting
  // one sets the style used when you drag a structure block from the palette below.
  const structureMenu = document.createElement("div");
  structureMenu.className = "ship-structure-menu";
  const structureMenuLabel = document.createElement("span");
  structureMenuLabel.className = "ship-structure-menu-label";
  structureMenuLabel.textContent = "Fairing";
  structureMenu.appendChild(structureMenuLabel);
  const structureShapeButtons: { btn: HTMLButtonElement; shape: StructureShape }[] = [];
  for (const shape of STRUCTURE_SHAPES) {
    const btn = document.createElement("button");
    btn.className = "ship-structure-btn";
    btn.dataset.shape = shape;
    btn.title = STRUCTURE_SHAPE_LABEL[shape];
    btn.setAttribute("aria-label", `structure shape ${STRUCTURE_SHAPE_LABEL[shape]}`);
    btn.style.backgroundImage = `url(${structureShapeDataURL(shape)})`;
    btn.addEventListener("click", () => {
      state.structureShape = shape;
      refreshStructureShapeButtons();
    });
    structureMenu.appendChild(btn);
    structureShapeButtons.push({ btn, shape });
  }
  document.body.appendChild(structureMenu);

  // The palette bar doubles as a trash target during a module drag (see onDocPointerMove).
  function pointerInPalette(clientX: number, clientY: number): boolean {
    const r = paletteBar.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }
  function enterTrashMode(): void {
    paletteBar.classList.add("ship-palette--trash");
  }
  function exitTrashMode(): void {
    paletteBar.classList.remove("ship-palette--trash", "ship-palette--trash-hot");
  }

  function refreshStructureShapeButtons(): void {
    for (const { btn, shape } of structureShapeButtons) {
      btn.classList.toggle("ship-structure-btn--active", shape === state.structureShape);
    }
  }
  function refreshPaletteIcons(): void {
    for (const { btn, type } of paletteButtons) btn.style.backgroundImage = `url(${iconDataURL(type, state.paletteSize)})`;
    sizeBtn.textContent = state.paletteSize;
  }
  function onPaletteDown(e: PointerEvent, type: ModuleType): void {
    if (state.view === "exterior" || drag) return;
    e.preventDefault();
    drag = {
      module: null,
      isNew: true,
      type,
      size: state.paletteSize,
      shape: type === "structure" ? state.structureShape : "block",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: true,
      candidate: null,
      valid: false,
    };
  }

  // Action bar: shown only while a module is selected — rotate / duplicate / remove it.
  const actionBar = document.createElement("div");
  actionBar.className = "ship-actions";
  const actionLabel = document.createElement("span");
  actionLabel.className = "ship-actions-label";
  actionBar.appendChild(actionLabel);
  const mkActionBtn = (label: string, act: string, aria: string, onClick: () => void): void => {
    const b = document.createElement("button");
    b.className = "ship-act-btn";
    b.dataset.act = act;
    b.textContent = label;
    b.setAttribute("aria-label", aria);
    b.addEventListener("click", onClick);
    actionBar.appendChild(b);
  };
  // Two rotation axes: yaw (vertical, swaps dx<->dz) and pitch (lateral, swaps dy<->dz).
  mkActionBtn("⟳ Y", "rotate-y", "rotate around vertical axis", () => rotateSelected("yaw"));
  mkActionBtn("⤴ X", "rotate-x", "rotate around lateral axis", () => rotateSelected("pitch"));
  mkActionBtn("⧉ Duplicate", "duplicate", "duplicate module", duplicateSelected);
  mkActionBtn("✕ Remove", "remove", "remove module", removeSelected);
  document.body.appendChild(actionBar);

  // Palette + fairing menu hide in exterior; action bar also hides with no selection.
  function updateBars(): void {
    const editing = state.view !== "exterior";
    paletteBar.classList.toggle("ship-hidden", !editing);
    structureMenu.classList.toggle("ship-hidden", !editing);
    const showActions = editing && selected !== null;
    actionBar.classList.toggle("ship-hidden", !showActions);
    if (selected) actionLabel.textContent = selectionLabel(selected);
  }

  // ---- GUI --------------------------------------------------------------------------
  // Deliberately small (the menu fix): the palette + action bars own the per-block editing
  // that v1's Edit folder did. What's left here is ship-wide: view, prefabs, hull, repair.
  const actions = { loadPrefab: () => loadPrefab(state.prefab), repair };

  gui.add(state, "view", ["internal", "exterior", "performance"]).name("View").onChange(applyView);
  gui.add(state, "prefab", ["fighter", "trader"]).name("Prefab");
  gui.add(actions, "loadPrefab").name("Load prefab");
  const hullColorCtrl = gui.addColor(state, "hullColor").name("Hull color").onChange((v: string) => hullMaterial.color.set(v));
  gui
    .add(state, "hullStyle", ["skinned", "plated", "box"])
    .name("Hull style")
    .onChange(() => {
      if (state.view === "exterior") buildHull();
    });
  gui.add(actions, "repair").name("Repair layout");
  gui.add(readout, "status").name("Status").listen().disable();

  const perfFolder = gui.addFolder("Performance");
  perfFolder.add(perf, "mass").name("Mass").listen().disable();
  perfFolder.add(perf, "thrust").name("Thrust").listen().disable();
  perfFolder.add(perf, "speed").name("Speed (u/s)").listen().disable();
  perfFolder.add(perf, "turn").name("Turn (deg/s)").listen().disable();
  perfFolder.add(perf, "powerGen").name("Power gen").listen().disable();
  perfFolder.add(perf, "powerUse").name("Power use").listen().disable();
  perfFolder.add(perf, "powerBalance").name("Power balance").listen().disable();
  perfFolder.add(perf, "heat").name("Heat").listen().disable();
  perfFolder.add(perf, "shieldHP").name("Shield HP").listen().disable();
  perfFolder.add(perf, "dps").name("Weapon DPS").listen().disable();
  perfFolder.add(perf, "cargoCap").name("Cargo cap").listen().disable();
  perfFolder.add(perf, "fuelCap").name("Fuel cap").listen().disable();
  perfFolder.add(perf, "burn").name("Fuel burn").listen().disable();
  perfFolder.add(perf, "range").name("Range").listen().disable();

  // Initial layout: the fighter, framed and validated. (refreshPaletteIcons after the
  // bars + GUI exist so button tiles are stamped once.)
  refreshPaletteIcons();
  refreshStructureShapeButtons();
  loadPrefab("fighter");

  return {
    dispose() {
      document.removeEventListener("pointerdown", onDocPointerDown, { capture: true });
      document.removeEventListener("pointermove", onDocPointerMove);
      document.removeEventListener("pointerup", onDocPointerUp);
      document.removeEventListener("pointercancel", onDocPointerCancel);
      paletteBar.remove();
      structureMenu.remove();
      actionBar.remove();

      // A palette ghost may be mid-flight (never registered in `modules`) — dispose it.
      if (drag && drag.isNew && drag.module) {
        moduleGroup.remove(drag.module.mesh);
        drag.module.material.dispose();
      }
      drag = null;

      clearModules(); // disposes each per-module material
      disposeHullMeshes();

      for (const g of moduleGeomCache.values()) g.dispose();
      for (const g of structureGeomCache.values()) g.dispose();
      for (const t of iconTextures.values()) t.dispose();
      for (const t of structureShapeIcons.values()) t.dispose();
      hullPanelMap.dispose();
      hullMaterial.dispose();
      nozzleMaterial.dispose();
      envMap.dispose();
      pmrem.dispose();

      scene.remove(root, ambient, dirLight, fillLight);

      scene.background = prevBackground;
      scene.fog = prevFog;
      scene.environment = prevEnvironment;
      camera.position.set(3, 2, 4);
      camera.quaternion.identity();
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.enabled = true;
      controls.update();
    },
  };
}

export const shipDesignerScene: TestScene = {
  id: "ship-designer",
  name: "Ship Designer (Modular)",
  description: "Assemble reactors, engines, weapons, cargo and structure fairings — hull covers the layout, stats update live.",
  setup,
};
