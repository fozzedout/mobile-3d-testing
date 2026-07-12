import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";

const GEOMETRIES = {
  Box: () => new THREE.BoxGeometry(1.4, 1.4, 1.4),
  Sphere: () => new THREE.SphereGeometry(1, 48, 32),
  Torus: () => new THREE.TorusKnotGeometry(0.7, 0.24, 150, 20),
} as const;

type GeometryName = keyof typeof GEOMETRIES;

function setup({ scene, gui }: SceneContext): SceneInstance {
  const params = {
    geometry: "Box" as GeometryName,
    color: "#4da3ff",
    metalness: 0.35,
    roughness: 0.4,
    wireframe: false,
    autoRotate: true,
    lightIntensity: 2.2,
  };

  const material = new THREE.MeshStandardMaterial({
    color: params.color,
    metalness: params.metalness,
    roughness: params.roughness,
  });
  const mesh = new THREE.Mesh(GEOMETRIES[params.geometry](), material);
  mesh.castShadow = true;
  scene.add(mesh);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: "#14161c", roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.3;
  ground.receiveShadow = true;
  scene.add(ground);

  const key = new THREE.DirectionalLight(0xffffff, params.lightIntensity);
  key.position.set(3, 4, 2);
  key.castShadow = true;
  scene.add(key);

  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);

  function swapGeometry(name: GeometryName): void {
    mesh.geometry.dispose();
    mesh.geometry = GEOMETRIES[name]();
  }

  gui.add(params, "geometry", Object.keys(GEOMETRIES)).name("Shape").onChange(swapGeometry);
  gui.addColor(params, "color").name("Color").onChange((v: string) => material.color.set(v));
  gui.add(params, "metalness", 0, 1, 0.01).onChange((v: number) => (material.metalness = v));
  gui.add(params, "roughness", 0, 1, 0.01).onChange((v: number) => (material.roughness = v));
  gui.add(params, "wireframe").onChange((v: boolean) => (material.wireframe = v));
  gui.add(params, "autoRotate").name("Auto-rotate");
  gui.add(params, "lightIntensity", 0, 6, 0.1).name("Light intensity").onChange((v: number) => (key.intensity = v));

  return {
    update(delta) {
      if (params.autoRotate) {
        mesh.rotation.y += delta * 0.6;
        mesh.rotation.x += delta * 0.2;
      }
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      scene.remove(mesh, ground, key, ambient);
    },
  };
}

export const basicsScene: TestScene = {
  id: "basics",
  name: "Basics",
  description: "Lighting, materials and geometry sanity check.",
  setup,
};
