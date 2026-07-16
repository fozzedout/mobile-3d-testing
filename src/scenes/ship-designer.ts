import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";

// One grid cell is 4 world units on a side; the grid is centered on the origin so
// cell (x,y,z) sits at ((x-(w-1)/2)*CELL, (y-(h-1)/2)*CELL, (z-(d-1)/2)*CELL).
// +z is the REAR of the ship (engines exhaust that way); -z is the nose.
const CELL = 4;

type ModuleType = "reactor" | "engine" | "fuel" | "weapon" | "shield" | "cargo" | "crew";
type ViewMode = "internal" | "exterior" | "performance";
type PrefabName = "fighter" | "trader";
type HullStyle = "plated" | "box";
// "idle" = nothing pending; "move" = a selected module is waiting for a destination tap;
// "add" = a palette/duplicate module is waiting to be placed on a tap.
type EditMode = "idle" | "move" | "add";

const MODULE_TYPES: ModuleType[] = ["reactor", "engine", "fuel", "weapon", "shield", "cargo", "crew"];

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

// Both prefabs are hand-authored to validate clean under every rule below.
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
  x: number;
  y: number;
  z: number;
  mesh: THREE.Mesh;
  // Each module owns its material: validity red-tint, selection glow and the
  // performance heat-lerp are all per-module, so a shared per-type material can't
  // express them. The BoxGeometry, by contrast, is shared across every module.
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

  const moduleGeometry = new THREE.BoxGeometry(CELL * 0.86, CELL * 0.86, CELL * 0.86);
  const highlightGeometry = new THREE.BoxGeometry(CELL * 0.92, CELL * 0.92, CELL * 0.92);
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

  const highlightMeshes: THREE.Mesh[] = [];
  const highlightMap = new Map<THREE.Object3D, Cell>();
  const meshToModule = new Map<THREE.Object3D, Module>();

  const state = {
    view: "internal" as ViewMode,
    prefab: "fighter" as PrefabName,
    paletteType: "cargo" as ModuleType,
    hullColor: "#5a6b8c",
    hullStyle: "plated" as HullStyle,
  };
  const readout = { status: "OK — layout valid" };
  const perf = {
    mass: 0, thrust: 0, speed: 0, turn: 0,
    powerGen: 0, powerUse: 0, powerBalance: 0, heat: 0,
    shieldHP: 0, dps: 0, cargoCap: 0, fuelCap: 0, burn: 0, range: 0,
  };

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
  function occupantAt(x: number, y: number, z: number): Module | null {
    // Layouts are tiny (<40 modules) so a linear scan is cheaper than maintaining a map.
    return modules.find((m) => m.x === x && m.y === y && m.z === z) ?? null;
  }
  function neighbors(m: Module): Module[] {
    const out: Module[] = [];
    const dirs: THREE.Vector3Tuple[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of dirs) {
      const n = occupantAt(m.x + dx, m.y + dy, m.z + dz);
      if (n) out.push(n);
    }
    return out;
  }
  function hasOccupiedNeighbor(x: number, y: number, z: number, exclude: Module | null): boolean {
    const dirs: THREE.Vector3Tuple[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of dirs) {
      const n = occupantAt(x + dx, y + dy, z + dz);
      if (n && n !== exclude) return true;
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
  function positionMesh(mesh: THREE.Object3D, x: number, y: number, z: number): void {
    mesh.position.set(cellX(x), cellY(y), cellZ(z));
  }
  function addModuleAt(type: ModuleType, x: number, y: number, z: number): Module {
    const material = new THREE.MeshStandardMaterial({ color: SPECS[type].color, metalness: 0.2, roughness: 0.6 });
    const mesh = new THREE.Mesh(moduleGeometry, material);
    positionMesh(mesh, x, y, z);
    moduleGroup.add(mesh);
    const m: Module = { type, x, y, z, mesh, material };
    modules.push(m);
    meshToModule.set(mesh, m);
    return m;
  }
  function removeModule(m: Module): void {
    moduleGroup.remove(m.mesh);
    meshToModule.delete(m.mesh);
    m.material.dispose();
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
    m.x = x;
    m.y = y;
    m.z = z;
    positionMesh(m.mesh, x, y, z);
  }

  // ---- highlights -------------------------------------------------------------------
  function clearHighlights(): void {
    for (const mesh of highlightMeshes) highlightGroup.remove(mesh);
    highlightMeshes.length = 0;
    highlightMap.clear();
  }
  function showHighlights(cells: Cell[]): void {
    clearHighlights();
    for (const c of cells) {
      const mesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
      positionMesh(mesh, c.x, c.y, c.z);
      highlightGroup.add(mesh);
      highlightMeshes.push(mesh);
      highlightMap.set(mesh, c);
    }
  }
  // Cheap adjacency proxy for connectivity: a placement is offered only if it keeps the
  // module's positional rule (engine→rear, weapon→exterior) AND touches an existing
  // module. Full re-validation runs after the move regardless.
  function validEmptyCells(type: ModuleType, exclude: Module | null): Cell[] {
    const out: Cell[] = [];
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        for (let z = 0; z < d; z++) {
          if (occupantAt(x, y, z)) continue;
          if (type === "engine" && z !== d - 1) continue;
          if (type === "weapon" && !isExteriorCell(x, y, z)) continue;
          if (!hasOccupiedNeighbor(x, y, z, exclude)) continue;
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
    let mass = 0, thrust = 0, powerGen = 0, powerUse = 0, heat = 0;
    let shieldHP = 0, dps = 0, cargoCap = 0, fuelCap = 0, burn = 0;
    for (const m of modules) {
      const s = SPECS[m.type];
      mass += s.mass;
      thrust += s.thrust;
      if (s.power > 0) powerGen += s.power;
      else powerUse += -s.power;
      heat += s.heat;
      shieldHP += s.shieldHP;
      dps += s.dps;
      cargoCap += s.cargoCap;
      fuelCap += s.fuelCap;
      burn += s.fuelBurn;
    }
    perf.mass = mass;
    perf.thrust = thrust;
    perf.speed = mass > 0 ? Math.round((thrust / mass) * 400) / 10 : 0;
    perf.turn = mass > 0 ? Math.round((thrust / mass) * 600) / 10 : 0;
    perf.powerGen = powerGen;
    perf.powerUse = powerUse;
    perf.powerBalance = powerGen - powerUse;
    perf.heat = heat;
    perf.shieldHP = shieldHP;
    perf.dps = dps;
    perf.cargoCap = cargoCap;
    perf.fuelCap = fuelCap;
    perf.burn = burn;
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

    // Rule 3: every engine must sit in the rearmost layer (direct rear access).
    const offRear = modules.filter((m) => m.type === "engine" && m.z !== d - 1);
    for (const m of offRear) offending.add(m);
    if (offRear.length > 0) issues.push(`${offRear.length > 1 ? `${offRear.length} engines` : "engine"} off rear`);

    // Rule 4: every weapon must sit on an exterior cell (external hardpoint).
    const interior = modules.filter((m) => m.type === "weapon" && !isExteriorCell(m.x, m.y, m.z));
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

  // ---- visual styling ---------------------------------------------------------------
  function restyle(): void {
    for (const m of modules) {
      const base = SPECS[m.type].color;
      m.material.color.set(base);
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
        m.material.emissive.set("#ff2a2a");
        m.material.emissiveIntensity = 0.7;
      } else if (isSel) {
        m.material.emissive.set(base);
        m.material.emissiveIntensity = 0.9;
      } else {
        // Baseline self-glow so module colors stay readable against the
        // near-black background — lit-only shading left them too dark to
        // tell types apart on a phone screen.
        m.material.emissive.set(base);
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
  function addEngineNozzles(rearZFor: (m: Module) => number): void {
    // A short nozzle protruding from the rear at each engine's (x,y) — the
    // hull visibly reflects the propulsion layout, whichever style is on.
    const nozzleLen = 0.9 * CELL;
    const nozzleGeometry = new THREE.CylinderGeometry(0.35 * CELL, 0.35 * CELL, nozzleLen, 12);
    for (const m of modules) {
      if (m.type !== "engine") continue;
      const nozzle = new THREE.Mesh(nozzleGeometry, nozzleMaterial);
      nozzle.rotation.x = Math.PI / 2; // align cylinder's y axis with +z
      nozzle.position.set(cellX(m.x), cellY(m.y), rearZFor(m) + nozzleLen / 2 - 0.1);
      hullGroup.add(nozzle);
    }
  }
  function buildHull(): void {
    disposeHullMeshes();
    if (modules.length === 0) return;
    if (state.hullStyle === "plated") buildPlatedHull();
    else buildBoxHull();
  }
  // Form-fitting "skin": one slightly-inflated armor plate per occupied cell
  // that has at least one exposed face, so the hull silhouette IS the module
  // layout (an arrowhead fighter reads as an arrowhead, a cargo spine reads
  // as a slab). Plates overlap their neighbors, which welds them into a
  // chunky low-poly sheet-metal shell; overlapping coplanar faces share the
  // same material and normal so they light identically — no shimmer.
  function buildPlatedHull(): void {
    const plateGeometry = new THREE.BoxGeometry(CELL * 1.3, CELL * 1.3, CELL * 1.3);
    for (const m of modules) {
      const enclosed =
        occupantAt(m.x + 1, m.y, m.z) && occupantAt(m.x - 1, m.y, m.z) &&
        occupantAt(m.x, m.y + 1, m.z) && occupantAt(m.x, m.y - 1, m.z) &&
        occupantAt(m.x, m.y, m.z + 1) && occupantAt(m.x, m.y, m.z - 1);
      if (enclosed) continue; // fully interior — its plate would never be seen
      const plate = new THREE.Mesh(plateGeometry, hullMaterial);
      plate.position.set(cellX(m.x), cellY(m.y), cellZ(m.z));
      hullGroup.add(plate);
    }
    addEngineNozzles((m) => cellZ(m.z) + (CELL * 1.3) / 2);
  }
  // The original single-shell alternative, kept for comparison: an inflated
  // box over the installed modules' bounding volume with a cone nose.
  function buildBoxHull(): void {
    // Bounding box of the INSTALLED modules — this is why the hull visibly re-fits when
    // modules are added, moved or removed.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const m of modules) {
      const px = cellX(m.x), py = cellY(m.y), pz = cellZ(m.z);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
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
    const p = PREFABS[name];
    w = p.w;
    h = p.h;
    d = p.d;
    rebuildGrid();
    for (const def of p.modules) addModuleAt(def.type, def.x, def.y, def.z);
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
    showHighlights(validEmptyCells(m.type, m));
    restyle();
  }
  function tapHighlight(cell: Cell): void {
    if (mode === "move" && selected) {
      moveModule(selected, cell.x, cell.y, cell.z);
    } else if (mode === "add" && pendingType) {
      selected = addModuleAt(pendingType, cell.x, cell.y, cell.z);
    }
    mode = "idle";
    pendingType = null;
    clearHighlights();
    onLayoutChanged();
  }
  function tapEmpty(): void {
    selected = null;
    mode = "idle";
    pendingType = null;
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
  function firstFreeCell(cells: Cell[], exclude: Module): Cell | null {
    for (const c of cells) {
      if (occupantAt(c.x, c.y, c.z)) continue;
      if (hasOccupiedNeighbor(c.x, c.y, c.z, exclude)) return c;
    }
    return null;
  }
  function repair(): void {
    const done: string[] = [];

    // (a) Off-rear engines → a free rear-layer cell adjacent to something.
    let enginesMoved = 0;
    for (const m of modules) {
      if (m.type !== "engine" || m.z === d - 1) continue;
      const rearCells: Cell[] = [];
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) rearCells.push({ x, y, z: d - 1 });
      const dest = firstFreeCell(rearCells, m);
      if (dest) {
        moveModule(m, dest.x, dest.y, dest.z);
        enginesMoved++;
      }
    }
    if (enginesMoved > 0) done.push(`moved ${enginesMoved} engine${enginesMoved > 1 ? "s" : ""} to rear`);

    // (b) Interior weapons → a free exterior cell adjacent to something.
    let weaponsMoved = 0;
    for (const m of modules) {
      if (m.type !== "weapon" || isExteriorCell(m.x, m.y, m.z)) continue;
      const extCells: Cell[] = [];
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) {
        if (isExteriorCell(x, y, z)) extCells.push({ x, y, z });
      }
      const dest = firstFreeCell(extCells, m);
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
      pendingType = state.paletteType;
      mode = "add";
      selected = null;
      showHighlights(validEmptyCells(pendingType, null));
      restyle();
    },
    duplicate: () => {
      if (!selected) return;
      pendingType = selected.type;
      mode = "add";
      showHighlights(validEmptyCells(pendingType, null));
      restyle();
    },
    replace: () => {
      if (!selected) return;
      selected.type = state.paletteType;
      selected.material.color.set(SPECS[state.paletteType].color);
      clearHighlights();
      mode = "idle";
      pendingType = null;
      onLayoutChanged();
    },
    remove: () => {
      if (!selected) return;
      removeModule(selected);
      selected = null;
      clearHighlights();
      mode = "idle";
      pendingType = null;
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
  editFolder.add(actions, "addModule").name("Add module (tap a green cell)");
  editFolder.add(actions, "duplicate").name("Duplicate selected");
  editFolder.add(actions, "replace").name("Replace selected with palette type");
  editFolder.add(actions, "remove").name("Remove selected");

  // Rotation is intentionally omitted: modules are single-slot in v1, so rotating one
  // in place changes nothing — there's no orientation to a single cell.

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

      moduleGeometry.dispose();
      highlightGeometry.dispose();
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
