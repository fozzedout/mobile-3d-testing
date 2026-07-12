import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";

function frameObject(ctx: SceneContext, object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const center = box.getCenter(new THREE.Vector3());

  object.position.sub(center);
  const distance = size * 1.4;
  ctx.controls.target.set(0, 0, 0);
  ctx.camera.position.set(distance * 0.6, distance * 0.4, distance * 0.8);
  ctx.camera.near = size / 100;
  ctx.camera.far = size * 100;
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
}

function countTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry;
      const index = geometry.index;
      total += index ? index.count / 3 : geometry.attributes.position.count / 3;
    }
  });
  return Math.round(total);
}

function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui } = ctx;
  const loader = new GLTFLoader();
  const info = { status: "Drop a .glb / .gltf file onto the canvas", triangles: 0, nodes: 0 };
  const params = { wireframe: false, autoRotate: true };

  scene.add(new THREE.HemisphereLight(0xffffff, 0x22242c, 1.2));
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.position.set(3, 4, 2);
  scene.add(light);

  let current: THREE.Object3D | null = null;

  function clearCurrent(): void {
    if (!current) return;
    current.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        (Array.isArray(material) ? material : [material]).forEach((m) => m.dispose());
      }
    });
    scene.remove(current);
    current = null;
  }

  function applyModel(root: THREE.Object3D): void {
    clearCurrent();
    current = root;
    scene.add(root);
    frameObject(ctx, root);
    info.triangles = countTriangles(root);
    let nodes = 0;
    root.traverse(() => nodes++);
    info.nodes = nodes;
    info.status = "Loaded";
  }

  function onFileDrop(file: File): void {
    info.status = `Loading ${file.name}…`;
    file
      .arrayBuffer()
      .then((buffer) => loader.parseAsync(buffer, ""))
      .then((gltf) => applyModel(gltf.scene))
      .catch((err: unknown) => {
        info.status = `Failed to load: ${String(err)}`;
      });
  }

  gui.add(info, "status").name("Status").listen().disable();
  gui.add(info, "triangles").listen().disable();
  gui.add(info, "nodes").listen().disable();
  gui.add(params, "wireframe").onChange((v: boolean) => {
    current?.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const material = child.material;
        (Array.isArray(material) ? material : [material]).forEach((m) => {
          if ("wireframe" in m) (m as THREE.MeshStandardMaterial).wireframe = v;
        });
      }
    });
  });
  gui.add(params, "autoRotate").name("Auto-rotate");

  return {
    onFileDrop,
    update(delta) {
      if (params.autoRotate && current) current.rotation.y += delta * 0.4;
    },
    dispose() {
      clearCurrent();
      scene.remove(light);
    },
  };
}

export const modelLoaderScene: TestScene = {
  id: "model-loader",
  name: "Load Model (GLTF)",
  description: "Drag & drop a .glb/.gltf to inspect real assets on-device.",
  setup,
};
