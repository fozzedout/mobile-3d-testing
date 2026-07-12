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
];
