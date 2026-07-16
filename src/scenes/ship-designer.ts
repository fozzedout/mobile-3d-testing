import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";

// One grid cell is 4 world units on a side; the grid is centered on the origin so
// cell (x,y,z) sits at ((x-(w-1)/2)*CELL, (y-(h-1)/2)*CELL, (z-(d-1)/2)*CELL).
// +z is the REAR of the ship (engines exhaust that way); -z is the nose.
const CELL = 4;

type ModuleType = "reactor" | "engine" | "fuel" | "weapon" | "shield" | "cargo" | "crew";
// Set-piece module sizes. Orientations are FIXED — the long axis always runs along z
// (the ship's nose-to-tail axis) and the wide axis along x — so there is no rotation UI.
// Fixed orientations keep v1's tap-only editing flow simple (a single anchor tap fully
// determines placement); rotation returns when it earns its place. Footprints in cells:
// S = 1 cell, M = 2 (1x1x2), L = 4 (2x1x2), XL = 8 (2x2x2).
type ModuleSize = "S" | "M" | "L" | "XL";
type ViewMode = "internal" | "exterior" | "performance";
type PrefabName = "fighter" | "trader";
type HullStyle = "plated" | "box";
// "idle" = nothing pending; "move" = a selected module is waiting for a destination tap;
// "add" = a palette/duplicate module is waiting to be placed on a tap.
type EditMode = "idle" | "move" | "add";

const MODULE_TYPES: ModuleType[] = ["reactor", "engine", "fuel", "weapon", "shield", "cargo", "crew"];
const MODULE_SIZES: ModuleSize[] = ["S", "M", "L", "XL"];

// Footprint dims (dx, dy, dz) in cells for each size. dx = width (x), dy = height (y),
// dz = length (z). Long axis along z, wide axis along x, per the fixed-orientation rule.
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
};

interface Cell {
  x: number;
  y: number;
  z: number;
}

interface PrefabDef {
  w: number;
  h: number;
  d: number;
  hullColor: string;
  modules: (Cell & { type: ModuleType })[];
}

// Both prefabs are hand-authored to validate clean under every rule below. Every module
// is size "S": the prefab stats are regression baselines (fighter mass 42 / speed 34.3 /
// power balance 1; trader mass 78 / cargo 80) and must not shift when sizes were added.
const PREFABS: Record<PrefabName, PrefabDef> = {
  // Fighter: excellent movement (3 engines / low mass), no cargo, tight power budget.
  fighter: {
    w: 3,
    h: 2,
    d: 4,
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
    w: 4,
    h: 2,
    d: 5,
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
  // Anchor = the module's minimum corner cell; the footprint occupies
  // [x, x+dx) x [y, y+dy) x [z, z+dz). dims are derived from size at creation.
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  mesh: THREE.Mesh;
  // Each module owns its material: validity red-tint, selection glow and the
  // performance heat-lerp are all per-module, so a shared per-type material can't
  // express them. The BoxGeometry (one per size) and the icon texture (one per
  // type+size) are, by contrast, shared across every matching module.
  material: THREE.MeshStandardMaterial;
}

// Local box corners / edges, reused to stamp a wireframe outline into every grid cell.
const BOX_CORNERS: THREE.Vector3Tuple[] = [
  [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
  [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
];
const BOX_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const RED = new THREE.Color("#ff3b3b");

// The six orthogonal neighbor directions, shared by adjacency / connectivity scans.
const DIRS: THREE.Vector3Tuple[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// ---- pictographic icon textures ------------------------------------------------------
// Module colors alone are unreadable on a phone, so every block wears a white
// pictogram baked onto a colored tile (like classic ship-editor games). Glyphs are drawn
// with canvas 2D paths — NOT emoji/text — because emoji rendering varies across
// platforms. One 128x128 texture per (type, size); the size label is stamped in the
// corner. A soft dark shadow backs the white strokes so they read on light tiles too.
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

function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevBackground = scene.background;
  const prevFog = scene.fog;
  scene.background = new THREE.Color("#0a0d14");
  // The shared scene carries a default near-range fog (far 30) sized for the
  // small demo scenes — this editor's camera orbits at ~50+ units, which
  // would put the whole grid past the fog's far plane and render it as pure
  // fog color. No fog wanted in an editor anyway.
  scene.fog = null;
  // Editor scene: OrbitControls stay ENABLED so a one-finger drag orbits the ship;
  // short, low-movement taps do the editing (see the pointer handlers below).
  controls.enabled = true;

  // ---- persistent resources (created once, disposed once at teardown) -------------
  const root = new THREE.Group();
  scene.add(root);

  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight.position.set(20, 30, 10);
  scene.add(ambient, dirLight);

  // One box geometry per size, shared across every module of that size; likewise one
  // slightly larger box per size for the placement ghosts. Both caches are disposed at
  // teardown (modules only own/dispose their material, never the shared geometry).
  const moduleGeomCache = new Map<ModuleSize, THREE.BoxGeometry>();
  const ghostGeomCache = new Map<ModuleSize, THREE.BoxGeometry>();
  function moduleGeometryFor(size: ModuleSize): THREE.BoxGeometry {
    let g = moduleGeomCache.get(size);
    if (!g) {
      const [dx, dy, dz] = SIZE_DIMS[size];
      g = new THREE.BoxGeometry(dx * CELL * 0.86, dy * CELL * 0.86, dz * CELL * 0.86);
      moduleGeomCache.set(size, g);
    }
    return g;
  }
  function ghostGeometryFor(size: ModuleSize): THREE.BoxGeometry {
    let g = ghostGeomCache.get(size);
    if (!g) {
      const [dx, dy, dz] = SIZE_DIMS[size];
      g = new THREE.BoxGeometry(dx * CELL * 0.92, dy * CELL * 0.92, dz * CELL * 0.92);
      ghostGeomCache.set(size, g);
    }
    return g;
  }

  // 7 types x 4 sizes = 28 icon textures, generated once and disposed at teardown.
  const iconTextures = new Map<string, THREE.CanvasTexture>();
  const iconKey = (type: ModuleType, size: ModuleSize): string => `${type}:${size}`;
  for (const type of MODULE_TYPES) {
    for (const size of MODULE_SIZES) {
      iconTextures.set(iconKey(type, size), makeIconTexture(type, size));
    }
  }

  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: "#43f08a",
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  const gridMaterial = new THREE.LineBasicMaterial({ color: "#28324d", transparent: true, opacity: 0.8 });
  const hullMaterial = new THREE.MeshStandardMaterial({ color: "#5a6b8c", flatShading: true, metalness: 0.2, roughness: 0.7 });
  const nozzleMaterial = new THREE.MeshStandardMaterial({ color: "#2b2f38", metalness: 0.5, roughness: 0.5 });

  const gridLines = new THREE.LineSegments(new THREE.BufferGeometry(), gridMaterial);
  const moduleGroup = new THREE.Group();
  const highlightGroup = new THREE.Group();
  const hullGroup = new THREE.Group();
  root.add(gridLines, moduleGroup, highlightGroup, hullGroup);

  // ---- mutable grid + layout state --------------------------------------------------
  let w = 3;
  let h = 2;
  let d = 4;
  const modules: Module[] = [];
  const offending = new Set<Module>(); // modules that break a rule; get the red tint.
  let selected: Module | null = null;
  let mode: EditMode = "idle";
  let pendingType: ModuleType | null = null; // module type awaiting placement in "add" mode.
  let pendingSize: ModuleSize | null = null; // module size awaiting placement in "add" mode.

  const highlightMeshes: THREE.Mesh[] = [];
  const highlightMap = new Map<THREE.Object3D, Cell>(); // ghost mesh -> placement anchor.
  const meshToModule = new Map<THREE.Object3D, Module>();

  const state = {
    view: "internal" as ViewMode,
    prefab: "fighter" as PrefabName,
    paletteType: "cargo" as ModuleType,
    paletteSize: "S" as ModuleSize,
    hullColor: "#5a6b8c",
    hullStyle: "plated" as HullStyle,
  };
  const readout = { status: "OK — layout valid", selected: "—" };
  const perf = {
    mass: 0, thrust: 0, speed: 0, turn: 0,
    powerGen: 0, powerUse: 0, powerBalance: 0, heat: 0,
    shieldHP: 0, dps: 0, cargoCap: 0, fuelCap: 0, burn: 0, range: 0,
  };

  const round1 = (v: number): number => Math.round(v * 10) / 10;

  // ---- geometry helpers -------------------------------------------------------------
  function cellX(x: number): number {
    return (x - (w - 1) / 2) * CELL;
  }
  function cellY(y: number): number {
    return (y - (h - 1) / 2) * CELL;
  }
  function cellZ(z: number): number {
    return (z - (d - 1) / 2) * CELL;
  }
  function isExteriorCell(x: number, y: number, z: number): boolean {
    return x === 0 || x === w - 1 || y === 0 || y === h - 1 || z === 0 || z === d - 1;
  }
  // World-space center of a footprint anchored at (x,y,z) with dims (dx,dy,dz).
  function footprintCenter(x: number, y: number, z: number, dx: number, dy: number, dz: number): THREE.Vector3 {
    return new THREE.Vector3(cellX(x + (dx - 1) / 2), cellY(y + (dy - 1) / 2), cellZ(z + (dz - 1) / 2));
  }
  function occupantAt(x: number, y: number, z: number): Module | null {
    // Layouts are tiny (<40 modules, footprints <=8 cells) so a linear scan over
    // modules and their footprints is cheaper than maintaining a cell->module map.
    for (const m of modules) {
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
          const occ = occupantAt(ix, iy, iz);
          if (occ && occ !== exclude) return false;
        }
      }
    }
    return true;
  }
  // At least one footprint cell lies on a grid boundary (weapon hardpoint rule).
  function footprintExterior(x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
    for (let ix = x; ix < x + dx; ix++) {
      for (let iy = y; iy < y + dy; iy++) {
        for (let iz = z; iz < z + dz; iz++) {
          if (isExteriorCell(ix, iy, iz)) return true;
        }
      }
    }
    return false;
  }
  // At least one footprint cell is orthogonally adjacent to another module's cell.
  function footprintHasNeighbor(x: number, y: number, z: number, dx: number, dy: number, dz: number, exclude: Module | null): boolean {
    for (let ix = x; ix < x + dx; ix++) {
      for (let iy = y; iy < y + dy; iy++) {
        for (let iz = z; iz < z + dz; iz++) {
          for (const [ddx, ddy, ddz] of DIRS) {
            const n = occupantAt(ix + ddx, iy + ddy, iz + ddz);
            if (n && n !== exclude) return true;
          }
        }
      }
    }
    return false;
  }

  function rebuildGrid(): void {
    const positions: number[] = [];
    const hs = CELL / 2;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        for (let z = 0; z < d; z++) {
          const cx = cellX(x);
          const cy = cellY(y);
          const cz = cellZ(z);
          for (const [a, b] of BOX_EDGES) {
            const ca = BOX_CORNERS[a];
            const cb = BOX_CORNERS[b];
            positions.push(cx + ca[0] * hs, cy + ca[1] * hs, cz + ca[2] * hs);
            positions.push(cx + cb[0] * hs, cy + cb[1] * hs, cz + cb[2] * hs);
          }
        }
      }
    }
    gridLines.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    gridLines.geometry = g;
  }

  // ---- module lifecycle -------------------------------------------------------------
  function positionModuleMesh(mesh: THREE.Object3D, m: Module): void {
    mesh.position.copy(footprintCenter(m.x, m.y, m.z, m.dx, m.dy, m.dz));
  }
  function addModuleAt(type: ModuleType, size: ModuleSize, x: number, y: number, z: number): Module {
    const [dx, dy, dz] = SIZE_DIMS[size];
    // Base color WHITE so the icon texture's baked colors show true; restyle() drives the
    // per-state tints (invalid red / heat lerp) as multiplies over the texture.
    const material = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: iconTextures.get(iconKey(type, size)) ?? null,
      metalness: 0.2,
      roughness: 0.6,
    });
    const mesh = new THREE.Mesh(moduleGeometryFor(size), material);
    const m: Module = { type, size, x, y, z, dx, dy, dz, mesh, material };
    positionModuleMesh(mesh, m);
    moduleGroup.add(mesh);
    modules.push(m);
    meshToModule.set(mesh, m);
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
  function moveModule(m: Module, x: number, y: number, z: number): void {
    // Size (and therefore dims) never changes on a move — only the anchor.
    m.x = x;
    m.y = y;
    m.z = z;
    positionModuleMesh(m.mesh, m);
  }

  // ---- highlights -------------------------------------------------------------------
  function clearHighlights(): void {
    for (const mesh of highlightMeshes) highlightGroup.remove(mesh);
    highlightMeshes.length = 0;
    highlightMap.clear();
  }
  // One translucent green GHOST BOX (the module's full footprint) at each valid anchor.
  // Tapping a ghost places/moves the module to that anchor.
  function showAnchorHighlights(size: ModuleSize, anchors: Cell[]): void {
    clearHighlights();
    const [dx, dy, dz] = SIZE_DIMS[size];
    const geom = ghostGeometryFor(size);
    for (const a of anchors) {
      const mesh = new THREE.Mesh(geom, highlightMaterial);
      mesh.position.copy(footprintCenter(a.x, a.y, a.z, dx, dy, dz));
      highlightGroup.add(mesh);
      highlightMeshes.push(mesh);
      highlightMap.set(mesh, a);
    }
  }
  // Valid placement anchors for a (type,size) module, excluding `exclude` (the module
  // being moved) from occupancy/adjacency: the footprint must fit fully inside the grid,
  // all its cells must be free, at least one cell must touch another module, and the
  // per-type positional rule (engine rear / weapon exterior) must hold at that anchor.
  // Full re-validation still runs after the edit regardless.
  function validAnchors(type: ModuleType, size: ModuleSize, exclude: Module | null): Cell[] {
    const [dx, dy, dz] = SIZE_DIMS[size];
    const out: Cell[] = [];
    for (let x = 0; x + dx <= w; x++) {
      for (let y = 0; y + dy <= h; y++) {
        for (let z = 0; z + dz <= d; z++) {
          if (!footprintFree(x, y, z, dx, dy, dz, exclude)) continue;
          if (type === "engine" && z + dz - 1 !== d - 1) continue;
          if (type === "weapon" && !footprintExterior(x, y, z, dx, dy, dz)) continue;
          if (!footprintHasNeighbor(x, y, z, dx, dy, dz, exclude)) continue;
          out.push({ x, y, z });
        }
      }
    }
    return out;
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

    // Rule 3: every engine's rearmost cell layer (anchor.z + dz - 1) must be the rear.
    const offRear = modules.filter((m) => m.type === "engine" && m.z + m.dz - 1 !== d - 1);
    for (const m of offRear) offending.add(m);
    if (offRear.length > 0) issues.push(`${offRear.length > 1 ? `${offRear.length} engines` : "engine"} off rear`);

    // Rule 4: every weapon must have at least one exterior footprint cell (a hardpoint).
    const interior = modules.filter((m) => m.type === "weapon" && !footprintExterior(m.x, m.y, m.z, m.dx, m.dy, m.dz));
    for (const m of interior) offending.add(m);
    if (interior.length > 0) issues.push(`${interior.length > 1 ? `${interior.length} weapons` : "weapon"} interior`);

    // Rule 5: everything must form one connected component; islands are unpowered.
    const largest = largestComponent();
    const disconnected = modules.filter((m) => !largest.has(m));
    for (const m of disconnected) offending.add(m);
    if (disconnected.length > 0) issues.push(`${disconnected.length} module${disconnected.length > 1 ? "s" : ""} disconnected`);

    readout.status = issues.length === 0
      ? "OK — layout valid"
      : `${issues.length} issue${issues.length > 1 ? "s" : ""}: ${issues.join("; ")}`;
  }

  function selectionLabel(): string {
    if (!selected) return "—";
    const cells = selected.dx * selected.dy * selected.dz;
    return `${selected.type} ${selected.size} (${cells} cell${cells > 1 ? "s" : ""})`;
  }

  // ---- visual styling ---------------------------------------------------------------
  function restyle(): void {
    readout.selected = selectionLabel();
    for (const m of modules) {
      // Emissive still uses the type color for selection/baseline self-glow (unchanged);
      // only the diffuse base color moved to white so the icon texture reads true.
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

  // ---- generated exterior hull ------------------------------------------------------
  function disposeHullMeshes(): void {
    // The plated style shares one geometry across many meshes — collect into a
    // set first so nothing gets double-disposed.
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
    if (state.hullStyle === "plated") buildPlatedHull();
    else buildBoxHull();
  }
  // Form-fitting "skin": one slightly-inflated armor plate per occupied CELL
  // that has at least one exposed face, so the hull silhouette IS the module
  // layout (an arrowhead fighter reads as an arrowhead, a cargo spine reads
  // as a slab). Plates overlap their neighbors, which welds them into a
  // chunky low-poly sheet-metal shell; overlapping coplanar faces share the
  // same material and normal so they light identically — no shimmer.
  function buildPlatedHull(): void {
    const plateGeometry = new THREE.BoxGeometry(CELL * 1.3, CELL * 1.3, CELL * 1.3);
    for (const m of modules) {
      for (let ix = m.x; ix < m.x + m.dx; ix++) {
        for (let iy = m.y; iy < m.y + m.dy; iy++) {
          for (let iz = m.z; iz < m.z + m.dz; iz++) {
            // Enclosed = all six cell-neighbors occupied (by any module, self included).
            const enclosed =
              occupantAt(ix + 1, iy, iz) && occupantAt(ix - 1, iy, iz) &&
              occupantAt(ix, iy + 1, iz) && occupantAt(ix, iy - 1, iz) &&
              occupantAt(ix, iy, iz + 1) && occupantAt(ix, iy, iz - 1);
            if (enclosed) continue; // fully interior — its plate would never be seen
            const plate = new THREE.Mesh(plateGeometry, hullMaterial);
            plate.position.set(cellX(ix), cellY(iy), cellZ(iz));
            hullGroup.add(plate);
          }
        }
      }
    }
    // Rear plane of an engine = the world z of its rearmost cell layer + half a plate.
    addEngineNozzles((m) => cellZ(m.z + m.dz - 1) + (CELL * 1.3) / 2);
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
    gridLines.visible = internalLike;
    moduleGroup.visible = internalLike;
    highlightGroup.visible = internalLike;
    hullGroup.visible = state.view === "exterior";
    if (state.view === "exterior") buildHull();
    if (state.view === "performance") perfFolder.open();
    else perfFolder.close();
    restyle();
  }
  function frameCamera(): void {
    controls.target.set(0, 0, 0);
    const diag = CELL * Math.hypot(w, h, d);
    // A portrait phone's horizontal FOV is the binding constraint here
    // (~27° at 55° vertical on a 390x844 viewport), so the camera has to sit
    // much farther back than the vertical FOV alone would suggest — at the
    // "obvious" ~1.3x diag distance the grid overflows the screen sideways.
    camera.position.set(diag * 1.35, diag * 1.05, diag * 1.6);
    controls.update();
  }

  // Recompute everything downstream of a layout edit.
  function onLayoutChanged(): void {
    recomputeStats();
    validate();
    restyle();
    if (state.view === "exterior") buildHull();
  }

  function loadPrefab(name: PrefabName): void {
    clearHighlights();
    clearModules();
    mode = "idle";
    pendingType = null;
    pendingSize = null;
    const p = PREFABS[name];
    w = p.w;
    h = p.h;
    d = p.d;
    rebuildGrid();
    // Prefabs are all size "S" — their baked-in stats are regression baselines.
    for (const def of p.modules) addModuleAt(def.type, "S", def.x, def.y, def.z);
    state.hullColor = p.hullColor;
    hullMaterial.color.set(p.hullColor);
    hullColorCtrl.updateDisplay();
    onLayoutChanged();
    frameCamera();
    applyView();
  }

  // ---- tap handling -----------------------------------------------------------------
  function tapModule(m: Module): void {
    selected = m;
    mode = "move";
    pendingType = null;
    pendingSize = null;
    showAnchorHighlights(m.size, validAnchors(m.type, m.size, m));
    restyle();
  }
  function tapHighlight(cell: Cell): void {
    if (mode === "move" && selected) {
      moveModule(selected, cell.x, cell.y, cell.z);
    } else if (mode === "add" && pendingType && pendingSize) {
      selected = addModuleAt(pendingType, pendingSize, cell.x, cell.y, cell.z);
    }
    mode = "idle";
    pendingType = null;
    pendingSize = null;
    clearHighlights();
    onLayoutChanged();
  }
  function tapEmpty(): void {
    selected = null;
    mode = "idle";
    pendingType = null;
    pendingSize = null;
    clearHighlights();
    restyle();
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function handleTap(clientX: number, clientY: number): void {
    if (state.view === "exterior") return; // exterior is a read-only preview.
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    // Only module + highlight meshes are interactive.
    const hits = raycaster.intersectObjects([...highlightMeshes, ...modules.map((m) => m.mesh)], false);
    if (hits.length === 0) {
      tapEmpty();
      return;
    }
    const obj = hits[0].object;
    const cell = highlightMap.get(obj);
    if (cell) {
      tapHighlight(cell);
      return;
    }
    const mod = meshToModule.get(obj);
    if (mod) {
      tapModule(mod);
      return;
    }
    tapEmpty();
  }

  // Tap vs orbit discrimination: a "tap" is a pointerup within 300ms and <8px of the
  // pointerdown. Anything longer or farther is an OrbitControls drag; we never
  // preventDefault, so orbiting keeps working. A second concurrent pointer (pinch/
  // two-finger orbit) cancels the pending tap so gestures don't misfire as edits.
  const TAP_MS = 300;
  const TAP_PX = 8;
  let down: { t: number; x: number; y: number } | null = null;
  let activePointers = 0;

  function onPointerDown(e: PointerEvent): void {
    activePointers++;
    down = activePointers === 1 ? { t: performance.now(), x: e.clientX, y: e.clientY } : null;
  }
  function onPointerUp(e: PointerEvent): void {
    activePointers = Math.max(0, activePointers - 1);
    const d0 = down;
    down = null;
    if (!d0) return;
    const dt = performance.now() - d0.t;
    const dist = Math.hypot(e.clientX - d0.x, e.clientY - d0.y);
    if (dt <= TAP_MS && dist < TAP_PX) handleTap(e.clientX, e.clientY);
  }
  function onPointerCancel(): void {
    activePointers = Math.max(0, activePointers - 1);
    down = null;
  }
  canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
  canvas.addEventListener("pointerup", onPointerUp, { passive: true });
  canvas.addEventListener("pointercancel", onPointerCancel, { passive: true });

  // ---- repair -----------------------------------------------------------------------
  // Nearest valid anchor for a module (nearest-first by cell distance from its current
  // anchor). Excludes the module itself from occupancy/adjacency.
  function nearestValidAnchor(m: Module): Cell | null {
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const a of validAnchors(m.type, m.size, m)) {
      const dd = Math.abs(a.x - m.x) + Math.abs(a.y - m.y) + Math.abs(a.z - m.z);
      if (dd < bestD) {
        bestD = dd;
        best = a;
      }
    }
    return best;
  }
  function repair(): void {
    const done: string[] = [];

    // (a) Off-rear engines → nearest valid anchor (footprint fits, rear rule holds, touches).
    let enginesMoved = 0;
    for (const m of modules) {
      if (m.type !== "engine" || m.z + m.dz - 1 === d - 1) continue;
      const dest = nearestValidAnchor(m);
      if (dest) {
        moveModule(m, dest.x, dest.y, dest.z);
        enginesMoved++;
      }
    }
    if (enginesMoved > 0) done.push(`moved ${enginesMoved} engine${enginesMoved > 1 ? "s" : ""} to rear`);

    // (b) Interior weapons → nearest valid anchor (exterior rule holds).
    let weaponsMoved = 0;
    for (const m of modules) {
      if (m.type !== "weapon" || footprintExterior(m.x, m.y, m.z, m.dx, m.dy, m.dz)) continue;
      const dest = nearestValidAnchor(m);
      if (dest) {
        moveModule(m, dest.x, dest.y, dest.z);
        weaponsMoved++;
      }
    }
    if (weaponsMoved > 0) done.push(`moved ${weaponsMoved} weapon${weaponsMoved > 1 ? "s" : ""} to a hardpoint`);

    // (c) Anything still off the main component gets scrapped.
    const largest = largestComponent();
    const orphans = modules.filter((m) => !largest.has(m));
    for (const m of orphans) removeModule(m);
    if (orphans.length > 0) done.push(`removed ${orphans.length} disconnected module${orphans.length > 1 ? "s" : ""}`);

    clearHighlights();
    selected = null;
    mode = "idle";
    pendingType = null;
    pendingSize = null;
    onLayoutChanged();

    let msg = done.length > 0 ? `Repaired: ${done.join("; ")}` : "Nothing to auto-repair";
    // Power is a design choice, not a placement bug — we don't invent reactors.
    if (perf.powerBalance < 0) msg += " — add a reactor or remove consumers";
    readout.status = msg;
  }

  // ---- GUI --------------------------------------------------------------------------
  const actions = {
    loadPrefab: () => loadPrefab(state.prefab),
    addModule: () => {
      // Add uses the palette's type AND size.
      pendingType = state.paletteType;
      pendingSize = state.paletteSize;
      mode = "add";
      selected = null;
      showAnchorHighlights(pendingSize, validAnchors(pendingType, pendingSize, null));
      restyle();
    },
    duplicate: () => {
      if (!selected) return;
      // Duplicate copies the SELECTED module's type + size, ignoring the palette.
      pendingType = selected.type;
      pendingSize = selected.size;
      mode = "add";
      showAnchorHighlights(pendingSize, validAnchors(pendingType, pendingSize, null));
      restyle();
    },
    replace: () => {
      if (!selected) return;
      // Keep the selected module's size and anchor; only the type changes. Since size is
      // unchanged the footprint is unchanged, so this is always safe to do in place —
      // just swap the icon texture to the new type's.
      selected.type = state.paletteType;
      selected.material.map = iconTextures.get(iconKey(selected.type, selected.size)) ?? null;
      selected.material.needsUpdate = true;
      clearHighlights();
      mode = "idle";
      pendingType = null;
      pendingSize = null;
      onLayoutChanged();
    },
    remove: () => {
      if (!selected) return;
      removeModule(selected);
      selected = null;
      clearHighlights();
      mode = "idle";
      pendingType = null;
      pendingSize = null;
      onLayoutChanged();
    },
    repair,
  };

  gui.add(state, "view", ["internal", "exterior", "performance"]).name("View").onChange(applyView);
  gui.add(state, "prefab", ["fighter", "trader"]).name("Prefab");
  gui.add(actions, "loadPrefab").name("Load prefab");
  const hullColorCtrl = gui.addColor(state, "hullColor").name("Hull color").onChange((v: string) => hullMaterial.color.set(v));
  gui
    .add(state, "hullStyle", ["plated", "box"])
    .name("Hull style")
    .onChange(() => {
      if (state.view === "exterior") buildHull();
    });
  gui.add(actions, "repair").name("Repair layout");
  gui.add(readout, "status").name("Status").listen().disable();

  const editFolder = gui.addFolder("Edit");
  editFolder.add(state, "paletteType", MODULE_TYPES).name("Module type");
  editFolder.add(state, "paletteSize", MODULE_SIZES).name("Module size");
  editFolder.add(readout, "selected").name("Selected").listen().disable();
  editFolder.add(actions, "addModule").name("Add module (tap a green ghost)");
  editFolder.add(actions, "duplicate").name("Duplicate selected");
  editFolder.add(actions, "replace").name("Replace selected with palette type");
  editFolder.add(actions, "remove").name("Remove selected");

  // Rotation is intentionally omitted: orientations are fixed (see ModuleSize), so v1's
  // single anchor tap fully determines a placement. Rotation returns when it earns it.

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

  // Initial layout: the fighter, framed and validated.
  loadPrefab("fighter");

  return {
    update(_dt, elapsed) {
      // Keep it calm: only breathe the green placement highlights. No per-frame
      // allocation (opacity is a shared scalar on the one highlight material).
      highlightMaterial.opacity = 0.25 + 0.15 * Math.sin(elapsed * 4);
    },
    dispose() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);

      clearHighlights();
      clearModules(); // disposes each per-module material
      disposeHullMeshes();
      gridLines.geometry.dispose();

      for (const g of moduleGeomCache.values()) g.dispose();
      for (const g of ghostGeomCache.values()) g.dispose();
      for (const t of iconTextures.values()) t.dispose();
      highlightMaterial.dispose();
      gridMaterial.dispose();
      hullMaterial.dispose();
      nozzleMaterial.dispose();

      scene.remove(root, ambient, dirLight);

      scene.background = prevBackground;
      scene.fog = prevFog;
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
  description: "Assemble reactors, engines, weapons and cargo on a 3D grid — hull stretches to fit, stats update live.",
  setup,
};
