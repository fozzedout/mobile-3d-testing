import type { TestScene } from "./types.ts";

export interface SceneMeta {
  id: string;
  name: string;
  description: string;
  load: () => Promise<TestScene>;
}

// Lazily imported so the initial mobile payload doesn't pay for scenes (and their
// dependencies, e.g. GLTFLoader) the visitor hasn't picked yet.
export const sceneRegistry: SceneMeta[] = [
  {
    id: "basics",
    name: "Basics",
    description: "Lighting, materials and geometry sanity check.",
    load: () => import("./basics.ts").then((m) => m.basicsScene),
  },
  {
    id: "particles",
    name: "Particle Stress Test",
    description: "Scales a point cloud to probe GPU fill-rate limits.",
    load: () => import("./particles.ts").then((m) => m.particlesScene),
  },
  {
    id: "touch-gyro",
    name: "Touch & Gyro",
    description: "Visualizes raw multi-touch points and device-orientation sensor data.",
    load: () => import("./touch-gyro.ts").then((m) => m.touchGyroScene),
  },
  {
    id: "model-loader",
    name: "Load Model (GLTF)",
    description: "Drag & drop a .glb/.gltf to inspect real assets on-device.",
    load: () => import("./model-loader.ts").then((m) => m.modelLoaderScene),
  },
  {
    id: "space-sim",
    name: "Space Sim (Touch Nav)",
    description: "6DOF flight lab with a compass HUD — a testbed for touch navigation schemes.",
    load: () => import("./space-sim.ts").then((m) => m.spaceSimScene),
  },
  {
    id: "ring-race",
    name: "Course: Ring Race",
    description: "Timed run: fly through every ring in order, start to finish.",
    load: () => import("./ring-race.ts").then((m) => m.ringRaceScene),
  },
  {
    id: "structure-run",
    name: "Course: Structure Run",
    description: "Timed run through a winding tunnel — avoid the walls and jutting obstacles.",
    load: () => import("./structure-run.ts").then((m) => m.structureRunScene),
  },
  {
    id: "asteroid-dodge",
    name: "Course: Asteroid Shower",
    description: "Timed run to the finish marker, dodging a continuous field of drifting rocks.",
    load: () => import("./asteroid-dodge.ts").then((m) => m.asteroidDodgeScene),
  },
  {
    id: "rotor-gates",
    name: "Course: Rotor Gates",
    description: "Match roll to a spinning slot before flying through — rated on alignment.",
    load: () => import("./rotor-gates.ts").then((m) => m.rotorGatesScene),
  },
  {
    id: "asteroids-arena",
    name: "Course: Asteroids Arena",
    description: "Fly, fire, and split rocks large to medium to small — nearest rocks shown on the Elite scanner.",
    load: () => import("./asteroids-arena.ts").then((m) => m.asteroidsArenaScene),
  },
  {
    id: "saucer-duel",
    name: "Course: Saucer Duel",
    description: "One-on-one dogfight against a flying saucer that dodges your fire and shoots back.",
    load: () => import("./saucer-duel.ts").then((m) => m.saucerDuelScene),
  },
  {
    id: "wedge-duel",
    name: "Course: Wedge Duel",
    description: "One-on-one dogfight against a conventional fighter — orientation-locked, banks into turns, nose-mounted guns.",
    load: () => import("./wedge-duel.ts").then((m) => m.wedgeDuelScene),
  },
  {
    id: "ship-designer",
    name: "Ship Designer (Modular)",
    description: "Assemble reactors, engines, weapons, cargo and structure fairings — hull covers the layout, stats update live.",
    load: () => import("./ship-designer.ts").then((m) => m.shipDesignerScene),
  },
  {
    id: "mega-station",
    name: "Mega Station (Scale Test)",
    description:
      "Approach a colossal rotating ring station — the bulk lives in the 3.8 km outer ring, the axis hub berths up to 8 ships; a magnetic capture field guides you onto your own pad.",
    load: () => import("./mega-station.ts").then((m) => m.megaStationScene),
  },
  {
    id: "docking-bay",
    name: "Course: Docking Bay",
    description: "Timed docking at a spinning voxel station — enter the rotating slot, land on the pad, take off and exit clean.",
    load: () => import("./docking-bay.ts").then((m) => m.dockingBayScene),
  },
];
