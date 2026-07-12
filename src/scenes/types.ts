import type GUI from "lil-gui";
import type * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  gui: GUI;
  canvas: HTMLCanvasElement;
}

export interface SceneInstance {
  update?(dt: number, elapsed: number): void;
  dispose?(): void;
  /** Called when a file is dropped onto the canvas (e.g. a .glb/.gltf model). */
  onFileDrop?(file: File): void;
}

export interface TestScene {
  id: string;
  name: string;
  description: string;
  setup(ctx: SceneContext): SceneInstance | Promise<SceneInstance>;
}
