import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { CompassHUD } from "../core/compass-hud.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { buildStarfield } from "../core/starfield.ts";

/**
 * Free-flight 6DOF navigation lab. Two objects sit far apart in a starfield,
 * found via the compass HUD rather than by sight, so touch-navigation
 * schemes (see FlightRig) can be tried without a task getting in the way.
 */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = null;
  scene.background = new THREE.Color("#02030a");
  camera.far = 900;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(350, 580);
  scene.add(stars);

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2, 100);
  scene.add(shipLight);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(18, 18, 18),
    new THREE.MeshStandardMaterial({ color: "#ff9f4d", emissive: "#7a3d00", emissiveIntensity: 0.6, roughness: 0.5 }),
  );
  cube.position.set(180, 25, -70);
  scene.add(cube);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(14, 32, 24),
    new THREE.MeshStandardMaterial({ color: "#4dd2ff", emissive: "#004a5c", emissiveIntensity: 0.6, roughness: 0.4 }),
  );
  sphere.position.set(-160, -35, 130);
  scene.add(sphere);

  const rig = new FlightRig(canvas);
  rig.reset([0, 0, 0]);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);

  const compass = new CompassHUD(120);

  rig.registerControls(gui);
  gui.add({ resetShip: () => rig.reset([0, 0, 0]) }, "resetShip").name("Reset position");

  const targets = [
    { label: "Cube", color: "#ff9f4d", position: cube.position },
    { label: "Sphere", color: "#4dd2ff", position: sphere.position },
  ];

  return {
    manualCamera: true,
    update(delta) {
      rig.update(delta);

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      compass.update(camera, targets, delta);
    },
    dispose() {
      rig.dispose();
      compass.dispose();

      cube.geometry.dispose();
      (cube.material as THREE.Material).dispose();
      sphere.geometry.dispose();
      (sphere.material as THREE.Material).dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      scene.remove(cube, sphere, stars, shipLight, ambient);

      scene.fog = prevFog;
      scene.background = prevBackground;
      camera.far = prevCameraFar;
      camera.position.set(3, 2, 4);
      camera.quaternion.identity();
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.enabled = true;
      controls.update();
    },
  };
}

export const spaceSimScene: TestScene = {
  id: "space-sim",
  name: "Space Sim (Touch Nav)",
  description: "6DOF flight lab with a compass HUD — a testbed for touch navigation schemes.",
  setup,
};
