import * as THREE from "three";
import type { SceneContext, SceneInstance, TestScene } from "./types.ts";
import { CompassHUD } from "../core/compass-hud.ts";
import { AlignmentHUD } from "../core/alignment-hud.ts";
import { FlightRig } from "../core/flight-rig.ts";
import { CourseTimer } from "../core/course-timer.ts";
import { HitFlash } from "../core/hit-flash.ts";
import { buildStarfield } from "../core/starfield.ts";
import { crossedPlane } from "../core/plane-crossing.ts";

// The ship's assumed silhouette (wider than tall) and each gate's slot —
// both narrow rectangles, so only roll (not position) determines whether
// you clip the panel or thread the slot cleanly.
const SHIP_HALF_WIDTH = 5;
const SHIP_HALF_HEIGHT = 1.5;
const SLOT_HALF_WIDTH = 11;
const SLOT_HALF_HEIGHT = 3.5;
const PANEL_HALF_SIZE = 26;
const CROSSING_RADIUS = PANEL_HALF_SIZE * 1.2;
const HIT_PENALTY_MS = 2500;
const INVULN_SECONDS = 0.8;

// Deterministic layout + spin speeds (fair for comparing best times), ramping
// up so later gates demand quicker, more confident roll adjustments.
const GATE_DEFS: { position: THREE.Vector3Tuple; spinDegPerSec: number }[] = [
  { position: [0, 0, -150], spinDegPerSec: 25 },
  { position: [18, 6, -310], spinDegPerSec: 45 },
  { position: [-12, -6, -470], spinDegPerSec: 70 },
  { position: [20, 0, -640], spinDegPerSec: 100 },
  { position: [0, 0, -810], spinDegPerSec: 140 },
];

interface Gate {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  spinRad: number;
  angle: number;
  group: THREE.Group;
  disposeMesh: () => void;
}

interface AlignmentResult {
  slotAngle: number;
  shipAngle: number;
  diffDeg: number;
  fits: boolean;
  score: number;
}

function computeBasis(normal: THREE.Vector3): { right: THREE.Vector3; up: THREE.Vector3 } {
  const worldUp = new THREE.Vector3(0, 1, 0);
  const reference = Math.abs(normal.dot(worldUp)) > 0.95 ? new THREE.Vector3(1, 0, 0) : worldUp;
  const right = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const up = new THREE.Vector3().crossVectors(normal, right).normalize();
  return { right, up };
}

function buildGateGroup(): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();

  const shape = new THREE.Shape();
  shape.moveTo(-PANEL_HALF_SIZE, -PANEL_HALF_SIZE);
  shape.lineTo(PANEL_HALF_SIZE, -PANEL_HALF_SIZE);
  shape.lineTo(PANEL_HALF_SIZE, PANEL_HALF_SIZE);
  shape.lineTo(-PANEL_HALF_SIZE, PANEL_HALF_SIZE);
  shape.closePath();

  const hole = new THREE.Path();
  hole.moveTo(-SLOT_HALF_WIDTH, -SLOT_HALF_HEIGHT);
  hole.lineTo(SLOT_HALF_WIDTH, -SLOT_HALF_HEIGHT);
  hole.lineTo(SLOT_HALF_WIDTH, SLOT_HALF_HEIGHT);
  hole.lineTo(-SLOT_HALF_WIDTH, SLOT_HALF_HEIGHT);
  hole.closePath();
  shape.holes.push(hole);

  const panelGeometry = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false });
  const panelMaterial = new THREE.MeshStandardMaterial({ color: "#4a5568", roughness: 0.7, metalness: 0.3 });
  const panel = new THREE.Mesh(panelGeometry, panelMaterial);
  panel.position.z = -1.5;
  group.add(panel);

  const frameMaterial = new THREE.MeshStandardMaterial({
    color: "#ffd24d",
    emissive: "#7a5200",
    emissiveIntensity: 0.7,
  });
  const barThickness = 1.2;
  const barDepth = 1.6;
  const hBarGeometry = new THREE.BoxGeometry(SLOT_HALF_WIDTH * 2 + barThickness * 2, barThickness, barDepth);
  const vBarGeometry = new THREE.BoxGeometry(barThickness, SLOT_HALF_HEIGHT * 2, barDepth);

  const topBar = new THREE.Mesh(hBarGeometry, frameMaterial);
  topBar.position.set(0, SLOT_HALF_HEIGHT + barThickness / 2, 0);
  const bottomBar = new THREE.Mesh(hBarGeometry, frameMaterial);
  bottomBar.position.set(0, -(SLOT_HALF_HEIGHT + barThickness / 2), 0);
  const leftBar = new THREE.Mesh(vBarGeometry, frameMaterial);
  leftBar.position.set(-(SLOT_HALF_WIDTH + barThickness / 2), 0, 0);
  const rightBar = new THREE.Mesh(vBarGeometry, frameMaterial);
  rightBar.position.set(SLOT_HALF_WIDTH + barThickness / 2, 0, 0);
  group.add(topBar, bottomBar, leftBar, rightBar);

  return {
    group,
    dispose() {
      panelGeometry.dispose();
      panelMaterial.dispose();
      hBarGeometry.dispose();
      vBarGeometry.dispose();
      frameMaterial.dispose();
    },
  };
}

function computeAlignment(gate: Gate, shipQuaternion: THREE.Quaternion): AlignmentResult {
  const slotDir = new THREE.Vector3(1, 0, 0).applyQuaternion(gate.group.quaternion);
  const shipRight = new THREE.Vector3(1, 0, 0).applyQuaternion(shipQuaternion);

  const projectedSlot = slotDir.clone().sub(gate.normal.clone().multiplyScalar(slotDir.dot(gate.normal)));
  const projectedShip = shipRight.clone().sub(gate.normal.clone().multiplyScalar(shipRight.dot(gate.normal)));

  const slotAngle = Math.atan2(projectedSlot.dot(gate.up), projectedSlot.dot(gate.right));
  const shipAngle = Math.atan2(projectedShip.dot(gate.up), projectedShip.dot(gate.right));

  let diff = shipAngle - slotAngle;
  diff = ((diff % Math.PI) + Math.PI) % Math.PI; // [0, π) — a rectangle looks the same rotated 180°
  if (diff > Math.PI / 2) diff = Math.PI - diff; // fold to [0, π/2]

  const cos = Math.cos(diff);
  const sin = Math.sin(diff);
  const effHalfW = SHIP_HALF_WIDTH * cos + SHIP_HALF_HEIGHT * sin;
  const effHalfH = SHIP_HALF_WIDTH * sin + SHIP_HALF_HEIGHT * cos;
  const fits = effHalfW <= SLOT_HALF_WIDTH && effHalfH <= SLOT_HALF_HEIGHT;

  const diffDeg = THREE.MathUtils.radToDeg(diff);
  const score = Math.max(0, Math.round(100 - (diffDeg / 90) * 100));

  return { slotAngle, shipAngle, diffDeg, fits, score };
}

function ratingLabel(diffDeg: number, fits: boolean): string {
  if (!fits) return "SMASHED";
  if (diffDeg <= 8) return "PERFECT";
  if (diffDeg <= 20) return "GOOD";
  return "CLIPPED";
}

/** Timed course: match roll to each spinning gate's slot before flying through — rated on how tight the alignment was. */
function setup(ctx: SceneContext): SceneInstance {
  const { scene, gui, camera, controls, canvas } = ctx;

  const prevFog = scene.fog;
  const prevBackground = scene.background;
  const prevCameraFar = camera.far;
  scene.fog = new THREE.Fog("#02030a", 200, 1000);
  scene.background = new THREE.Color("#02030a");
  camera.far = 1050;
  camera.updateProjectionMatrix();
  controls.enabled = false;

  const stars = buildStarfield(780, 1000, 3000);
  scene.add(stars);
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);
  const shipLight = new THREE.PointLight(0xffffff, 2, 120);
  scene.add(shipLight);

  const gates: Gate[] = GATE_DEFS.map((def, i) => {
    const position = new THREE.Vector3(...def.position);
    const isLast = i === GATE_DEFS.length - 1;
    const other = isLast ? GATE_DEFS[i - 1].position : GATE_DEFS[i + 1].position;
    const toOther = new THREE.Vector3(...other).sub(position).normalize();
    const normal = isLast ? toOther.clone().negate() : toOther;
    const { right, up } = computeBasis(normal);

    const basis = new THREE.Matrix4().makeBasis(right, up, normal);
    const baseQuaternion = new THREE.Quaternion().setFromRotationMatrix(basis);

    const { group, dispose } = buildGateGroup();
    group.position.copy(position);
    group.quaternion.copy(baseQuaternion);
    scene.add(group);

    return {
      position,
      normal,
      right,
      up,
      baseQuaternion,
      spinRad: THREE.MathUtils.degToRad(def.spinDegPerSec),
      angle: 0,
      group,
      disposeMesh: dispose,
    };
  });

  const rig = new FlightRig(canvas);
  rig.reset([0, 0, 0]);
  camera.position.copy(rig.position);
  camera.quaternion.copy(rig.quaternion);
  const prevShipPos = rig.position.clone();

  const compass = new CompassHUD(120);
  const alignmentHud = new AlignmentHUD(130);
  const timer = new CourseTimer({ storageKey: "course-best:rotor-gates" });
  const hitFlash = new HitFlash();

  let currentGate = 0;
  let invulnerable = 0;
  const scores: number[] = [];
  const readout = { lastGate: "Match roll to the slot before entering", avgAlignment: "—" };

  function restart(): void {
    rig.reset([0, 0, 0]);
    prevShipPos.copy(rig.position);
    currentGate = 0;
    invulnerable = 0;
    scores.length = 0;
    readout.lastGate = "Match roll to the slot before entering";
    readout.avgAlignment = "—";
    timer.restart();
  }

  rig.registerControls(gui);
  gui.add(timer, "statusText").name("Status").listen().disable();
  gui.add(timer, "timeText").name("Time").listen().disable();
  gui.add(timer, "hits").name("Smashed").listen().disable();
  gui.add(readout, "lastGate").name("Last gate").listen().disable();
  gui.add(readout, "avgAlignment").name("Avg alignment").listen().disable();
  gui.add(timer, "bestText").name("Best").listen().disable();
  gui.add({ restart }, "restart").name("Restart");

  function applyHit(pushDir: THREE.Vector3): void {
    if (invulnerable > 0) return;
    timer.addPenalty(HIT_PENALTY_MS);
    invulnerable = INVULN_SECONDS;
    hitFlash.trigger();
    rig.position.addScaledVector(pushDir, 3);
    const intoWall = rig.velocity.dot(pushDir);
    if (intoWall < 0) rig.velocity.addScaledVector(pushDir, -intoWall);
  }

  function checkGateCrossing(): void {
    if (currentGate >= gates.length) return;
    const gate = gates[currentGate];
    if (!crossedPlane(prevShipPos, rig.position, gate.position, gate.normal, CROSSING_RADIUS)) return;

    const result = computeAlignment(gate, rig.quaternion);
    const label = ratingLabel(result.diffDeg, result.fits);

    if (!result.fits) {
      applyHit(gate.normal.clone().negate());
      readout.lastGate = `Gate ${currentGate + 1}: ${label} (${Math.round(result.diffDeg)}° off)`;
      return;
    }

    scores.push(result.score);
    readout.lastGate = `Gate ${currentGate + 1}: ${label} (${result.score}%)`;
    currentGate += 1;

    if (currentGate >= gates.length) {
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      readout.avgAlignment = `${avg}%`;
      timer.finish();
    }
  }

  return {
    manualCamera: true,
    update(delta) {
      if (timer.state !== "countdown") rig.update(delta);
      timer.update(delta);
      if (invulnerable > 0) invulnerable -= delta;

      for (const gate of gates) {
        gate.angle += gate.spinRad * delta;
        const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), gate.angle);
        gate.group.quaternion.copy(gate.baseQuaternion).multiply(spin);
      }

      if (timer.state === "racing") checkGateCrossing();
      prevShipPos.copy(rig.position);

      camera.position.copy(rig.position);
      camera.quaternion.copy(rig.quaternion);
      shipLight.position.copy(rig.position);

      if (currentGate < gates.length) {
        const gate = gates[currentGate];
        const live = computeAlignment(gate, rig.quaternion);
        alignmentHud.update(
          live.slotAngle,
          live.shipAngle,
          live.fits,
          live.fits ? `${ratingLabel(live.diffDeg, true)} · ${Math.round(live.diffDeg)}°` : `${Math.round(live.diffDeg)}° off`,
        );
        compass.update(camera, [{ label: `Gate ${currentGate + 1}/${gates.length}`, color: "#ffd24d", position: gate.position }], delta);
      }
    },
    dispose() {
      rig.dispose();
      compass.dispose();
      alignmentHud.dispose();
      hitFlash.dispose();

      gates.forEach((gate) => {
        gate.disposeMesh();
        scene.remove(gate.group);
      });

      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      scene.remove(stars, ambient, shipLight);

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

export const rotorGatesScene: TestScene = {
  id: "rotor-gates",
  name: "Course: Rotor Gates",
  description: "Match roll to a spinning slot before flying through — rated on alignment.",
  setup,
};
