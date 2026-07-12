import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";

const MAX_COUNT = 250_000;

function buildGeometry(count: number, radius: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const r = radius * Math.cbrt(Math.random());
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    color.setHSL(0.55 + Math.random() * 0.3, 0.8, 0.5 + Math.random() * 0.3);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Adjustable-count point cloud — a quick way to find where a device's GPU starts to sweat. */
function setup({ scene, gui }: SceneContext): SceneInstance {
  const params = {
    count: 40_000,
    size: 0.03,
    spin: true,
    spread: 3,
  };

  let points = new THREE.Points(
    buildGeometry(params.count, params.spread),
    new THREE.PointsMaterial({
      size: params.size,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  scene.add(points);

  function rebuild(): void {
    points.geometry.dispose();
    points.geometry = buildGeometry(params.count, params.spread);
  }

  gui.add(params, "count", 1_000, MAX_COUNT, 1_000).name("Particle count").onFinishChange(rebuild);
  gui.add(params, "spread", 0.5, 8, 0.1).onFinishChange(rebuild);
  gui.add(params, "size", 0.005, 0.15, 0.005).onChange((v: number) => {
    (points.material as THREE.PointsMaterial).size = v;
  });
  gui.add(params, "spin").name("Spin");

  return {
    update(delta) {
      if (params.spin) points.rotation.y += delta * 0.15;
    },
    dispose() {
      points.geometry.dispose();
      (points.material as THREE.Material).dispose();
      scene.remove(points);
    },
  };
}

export const particlesScene: TestScene = {
  id: "particles",
  name: "Particle Stress Test",
  description: "Scales a point cloud to probe GPU fill-rate limits.",
  setup,
};
