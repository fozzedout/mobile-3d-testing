import * as THREE from "three";
import type GUI from "lil-gui";
import { AudioClicker } from "./audio-ticks.ts";
import { VirtualJoystick } from "./virtual-joystick.ts";
import { EdgeSlider } from "./edge-slider.ts";
import { orientationToQuaternion, requestMotionPermission } from "./device-orientation.ts";

const DEFAULT_MAX_SPEED = 60;
const DEFAULT_LOOK_RATE = 90; // deg/sec at full stick deflection

// Time-based rate/position hybrid: a look-stick touch shorter than this
// (in time AND distance) is treated as a precise position-control flick;
// crossing either threshold promotes it to ongoing rate control.
const FLICK_TIME_MS = 220;
const FLICK_DIST_PX = 38;
const FLICK_MAX_ANGLE = THREE.MathUtils.degToRad(10);

// A second finger landing in the move zone controls vertical strafe (drag up
// to ascend, down to descend) — this px range maps to full deflection.
const VERTICAL_RANGE_PX = 90;

type Scheme = "dual-stick" | "gyro-move";
type AuxInput = "sliders" | "fingers";

/**
 * The shared 6DOF touch-navigation rig originally built for the Space Sim
 * scene: dual floating joysticks (rate-control translate + look, with a
 * second finger on the look stick switching to a twist-to-roll gesture) or
 * gyro-look + touch-thrust, plus the tunable extras (gyro fine-trim,
 * precision-flick, rotational inertia). Any scene that wants "the touch-nav
 * controls we already tuned" instantiates this and reads `position`/
 * `quaternion`/`velocity` each frame instead of re-deriving the physics.
 */
export class FlightRig {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();

  readonly params = {
    scheme: "dual-stick" as Scheme,
    maxSpeed: DEFAULT_MAX_SPEED,
    lookRate: DEFAULT_LOOK_RATE,
    audioFeedback: false,
    motionStatus: "tap Enable motion",
    speed: 0,
    gyroTrim: false,
    gyroTrimStrength: 0.25,
    precisionFlick: false,
    rotationalInertia: false,
    inertiaRampMs: 120,
    inertiaBrakeMs: 90,
    auxInput: "sliders" as AuxInput,
  };

  private readonly canvas: HTMLCanvasElement;
  private readonly angularVelocity = { yaw: 0, pitch: 0 };
  private readonly gyroQuaternion = new THREE.Quaternion();
  private haveGyro = false;
  private gyroTrimPrev: THREE.Quaternion | null = null;
  private pendingRoll = 0;

  private readonly audio = new AudioClicker();
  private readonly moveStick: VirtualJoystick;
  private readonly lookStick: VirtualJoystick;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private moveTouchId: number | null = null;
  private moveOrigin = { x: 0, y: 0 };
  private moveSecondaryTouchId: number | null = null;
  private moveSecondaryOriginY = 0;
  private fingerVerticalInput = 0;
  private readonly verticalIndicator: HTMLDivElement;
  private readonly verticalSlider: EdgeSlider;
  private readonly rollSlider: EdgeSlider;
  private lookTouchId: number | null = null;
  private lookOrigin = { x: 0, y: 0 };
  private lastLookDx = 0;
  private lastLookDy = 0;
  private lookTouchStartTime = 0;
  private lookMode: "position" | "rate" = "rate";
  private readonly lookBaseQuaternion = new THREE.Quaternion();
  private rollTouchId: number | null = null;
  private rollPrevAngle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.moveStick = new VirtualJoystick(document.body, { color: "#8fe3a0", audio: this.audio });
    this.lookStick = new VirtualJoystick(document.body, { color: "#4da3ff", audio: this.audio });
    this.moveStick.audioEnabled = this.params.audioFeedback;
    this.lookStick.audioEnabled = this.params.audioFeedback;

    this.verticalIndicator = document.createElement("div");
    this.verticalIndicator.className = "vertical-indicator";
    this.verticalIndicator.textContent = "⇕";
    this.verticalIndicator.hidden = true;
    document.body.appendChild(this.verticalIndicator);

    this.verticalSlider = new EdgeSlider(document.body, { side: "left", color: "#8fe3a0" });
    this.rollSlider = new EdgeSlider(document.body, { side: "right", color: "#4da3ff" });
    const slidersVisible = this.params.auxInput === "sliders";
    this.verticalSlider.setVisible(slidersVisible);
    this.rollSlider.setVisible(slidersVisible);

    canvas.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    canvas.addEventListener("pointermove", this.onPointerMove, { passive: true });
    canvas.addEventListener("pointerup", this.releasePointer, { passive: true });
    canvas.addEventListener("pointercancel", this.releasePointer, { passive: true });
  }

  /** Adds every control to the given GUI (control scheme, sensitivity, the tunable extras). */
  registerControls(gui: GUI): void {
    const params = this.params;
    gui.add(params, "scheme", ["dual-stick", "gyro-move"]).name("Control scheme").onChange(this.resetTouchState);
    gui.add({ enableMotion: this.enableMotion }, "enableMotion").name("Enable motion");
    gui.add(params, "motionStatus").name("Motion status").listen().disable();
    gui.add(params, "gyroTrim").name("Gyro fine-trim (dual-stick)");
    gui.add(params, "gyroTrimStrength", 0.05, 0.6, 0.05).name("Gyro trim strength");
    gui.add(params, "precisionFlick").name("Precision flick mode");
    gui.add(params, "rotationalInertia").name("Rotational inertia");
    gui.add(params, "inertiaRampMs", 30, 400, 10).name("Inertia ramp-in (ms)");
    gui.add(params, "inertiaBrakeMs", 30, 400, 10).name("Inertia brake (ms)");
    gui
      .add(params, "auxInput", ["sliders", "fingers"])
      .name("Vertical/roll input")
      .onChange(this.onAuxInputChange);
    gui.add(params, "maxSpeed", 10, 150, 5).name("Max speed");
    gui.add(params, "lookRate", 30, 180, 5).name("Look sensitivity");
    gui.add(params, "audioFeedback").name("Audio feedback").onChange((v: boolean) => {
      this.moveStick.audioEnabled = v;
      this.lookStick.audioEnabled = v;
    });
    gui.add(params, "speed").name("Speed (u/s)").listen().disable();
  }

  reset(position: THREE.Vector3Tuple = [0, 0, 0], quaternion?: THREE.Quaternion): void {
    this.position.set(...position);
    this.quaternion.copy(quaternion ?? new THREE.Quaternion());
    this.velocity.set(0, 0, 0);
    this.angularVelocity.yaw = 0;
    this.angularVelocity.pitch = 0;
  }

  private readonly handleOrientation = (e: DeviceOrientationEvent): void => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const screenAngle = THREE.MathUtils.degToRad(screen.orientation?.angle ?? 0);
    orientationToQuaternion(e.alpha, e.beta, e.gamma, screenAngle, this.gyroQuaternion);
    this.haveGyro = true;
  };

  private readonly enableMotion = async (): Promise<void> => {
    const result = await requestMotionPermission();
    if (result === "unsupported") {
      this.params.motionStatus = "unsupported on this device";
      return;
    }
    if (result === "denied") {
      this.params.motionStatus = "permission denied";
      return;
    }
    window.addEventListener("deviceorientation", this.handleOrientation);
    this.params.motionStatus = "listening";
  };

  private readonly resetTouchState = (): void => {
    this.moveStick.hide();
    this.lookStick.hide();
    this.pointers.clear();
    this.moveTouchId = null;
    this.moveSecondaryTouchId = null;
    this.fingerVerticalInput = 0;
    this.verticalIndicator.hidden = true;
    this.verticalSlider.forceReset();
    this.rollSlider.forceReset();
    this.lookTouchId = null;
    this.rollTouchId = null;
    this.gyroTrimPrev = null;
  };

  private readonly onAuxInputChange = (): void => {
    const slidersVisible = this.params.auxInput === "sliders";
    this.verticalSlider.setVisible(slidersVisible);
    this.rollSlider.setVisible(slidersVisible);
    this.resetTouchState();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a reliability nicety (keeps tracking a finger that slides off
      // the canvas); if the platform refuses it, plain event delivery still works.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.params.auxInput === "sliders") {
      if (this.verticalSlider.tryClaim(e.pointerId, e.clientX, e.clientY)) return;
      if (this.rollSlider.tryClaim(e.pointerId, e.clientX, e.clientY)) return;
    }

    const isRight = e.clientX >= window.innerWidth / 2;
    const inMoveZone = this.params.scheme === "gyro-move" || !isRight;

    if (inMoveZone) {
      if (this.moveTouchId === null) {
        this.moveTouchId = e.pointerId;
        this.moveOrigin = { x: e.clientX, y: e.clientY };
        this.moveStick.show(e.clientX, e.clientY);
      } else if (this.params.auxInput === "fingers" && this.moveSecondaryTouchId === null) {
        // A second finger in the move zone controls vertical strafe, mirroring
        // how a second finger on the look stick controls roll.
        this.moveSecondaryTouchId = e.pointerId;
        this.moveSecondaryOriginY = e.clientY;
        this.verticalIndicator.hidden = false;
        this.verticalIndicator.style.left = `${e.clientX}px`;
        this.verticalIndicator.style.top = `${e.clientY}px`;
      }
      return;
    }

    if (this.lookTouchId === null) {
      this.lookTouchId = e.pointerId;
      this.lookOrigin = { x: e.clientX, y: e.clientY };
      this.lastLookDx = 0;
      this.lastLookDy = 0;
      this.lookTouchStartTime = performance.now();
      this.lookMode = "position";
      this.lookBaseQuaternion.copy(this.quaternion);
      this.lookStick.show(e.clientX, e.clientY);
    } else if (this.params.auxInput === "fingers" && this.rollTouchId === null) {
      this.rollTouchId = e.pointerId;
      const a = this.pointers.get(this.lookTouchId);
      if (a) this.rollPrevAngle = Math.atan2(e.clientY - a.y, e.clientX - a.x);
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.params.auxInput === "sliders") {
      if (this.verticalSlider.feed(e.pointerId, e.clientY)) return;
      if (this.rollSlider.feed(e.pointerId, e.clientY)) return;
    }

    if (e.pointerId === this.moveTouchId) {
      this.moveStick.feed(e.clientX - this.moveOrigin.x, e.clientY - this.moveOrigin.y);
    } else if (e.pointerId === this.moveSecondaryTouchId) {
      const dy = e.clientY - this.moveSecondaryOriginY;
      this.fingerVerticalInput = THREE.MathUtils.clamp(-dy / VERTICAL_RANGE_PX, -1, 1);
    }

    // A second finger landing on the look stick switches that hand to a
    // twist-to-roll gesture instead of feeding the look stick further.
    if (this.rollTouchId !== null && this.lookTouchId !== null) {
      const a = this.pointers.get(this.lookTouchId);
      const b = this.pointers.get(this.rollTouchId);
      if (a && b) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        let delta = angle - this.rollPrevAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        this.pendingRoll += delta;
        this.rollPrevAngle = angle;
      }
    } else if (e.pointerId === this.lookTouchId) {
      this.lastLookDx = e.clientX - this.lookOrigin.x;
      this.lastLookDy = e.clientY - this.lookOrigin.y;
      this.lookStick.feed(this.lastLookDx, this.lastLookDy);
    }
  };

  private readonly releasePointer = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.verticalSlider.release(e.pointerId);
    this.rollSlider.release(e.pointerId);

    if (e.pointerId === this.moveTouchId) {
      this.moveTouchId = null;
      this.moveStick.hide();
      this.moveSecondaryTouchId = null;
      this.fingerVerticalInput = 0;
      this.verticalIndicator.hidden = true;
    }
    if (e.pointerId === this.moveSecondaryTouchId) {
      this.moveSecondaryTouchId = null;
      this.fingerVerticalInput = 0;
      this.verticalIndicator.hidden = true;
    }
    if (e.pointerId === this.lookTouchId) {
      this.lookTouchId = null;
      this.lookStick.hide();
      this.rollTouchId = null;
    }
    if (e.pointerId === this.rollTouchId) {
      this.rollTouchId = null;
    }
  };

  update(delta: number): void {
    const params = this.params;
    const lookRateRad = THREE.MathUtils.degToRad(params.lookRate);

    if (params.scheme === "gyro-move") {
      if (this.haveGyro) this.quaternion.slerp(this.gyroQuaternion, Math.min(1, delta * 6));
      this.angularVelocity.yaw = 0;
      this.angularVelocity.pitch = 0;
    } else {
      // Time-based rate/position hybrid: a fresh look-stick touch starts in
      // "position" mode (finger offset maps directly to a small, precise
      // absolute look angle, no momentum) and promotes to ongoing rate
      // control once it's held past a time or distance threshold.
      let handledByFlick = false;
      if (params.precisionFlick && this.lookTouchId !== null) {
        if (this.lookMode === "position") {
          const held = performance.now() - this.lookTouchStartTime;
          const dist = Math.hypot(this.lastLookDx, this.lastLookDy);
          if (held < FLICK_TIME_MS && dist < FLICK_DIST_PX) {
            const posYaw = -THREE.MathUtils.clamp(this.lastLookDx / FLICK_DIST_PX, -1, 1) * FLICK_MAX_ANGLE;
            const posPitch = -THREE.MathUtils.clamp(this.lastLookDy / FLICK_DIST_PX, -1, 1) * FLICK_MAX_ANGLE;
            const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(posPitch, posYaw, 0, "YXZ"));
            this.quaternion.copy(this.lookBaseQuaternion).multiply(offset);
            this.angularVelocity.yaw = 0;
            this.angularVelocity.pitch = 0;
            handledByFlick = true;
          } else {
            this.lookMode = "rate"; // promoted — falls through to rate control below, continuing from here
          }
        }
      }

      if (!handledByFlick) {
        const targetYawRate = -this.lookStick.value.x * lookRateRad;
        const targetPitchRate = -this.lookStick.value.y * lookRateRad;

        if (params.rotationalInertia) {
          const stickActive = Math.hypot(this.lookStick.value.x, this.lookStick.value.y) > 0.02;
          // Tunable smoothing while steering vs. decay the instant the stick
          // is released — kept as separate sliders since "let go" should
          // stay a fairly trustworthy stop signal even at gentler settings.
          const timeConstant = (stickActive ? params.inertiaRampMs : params.inertiaBrakeMs) / 1000;
          const factor = 1 - Math.exp(-delta / timeConstant);
          this.angularVelocity.yaw = THREE.MathUtils.lerp(this.angularVelocity.yaw, targetYawRate, factor);
          this.angularVelocity.pitch = THREE.MathUtils.lerp(this.angularVelocity.pitch, targetPitchRate, factor);
        } else {
          this.angularVelocity.yaw = targetYawRate;
          this.angularVelocity.pitch = targetPitchRate;
        }

        const lookDelta = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(this.angularVelocity.pitch * delta, this.angularVelocity.yaw * delta, 0, "YXZ"),
        );
        this.quaternion.multiply(lookDelta);
      }

      // Gyro fine-trim: adds the device's relative tilt since last frame as a
      // small additive nudge on top of stick-driven look, rather than
      // replacing it outright (avoids the "absolute mapping" finickiness of
      // the gyro-move scheme while still giving fine-aim assistance).
      if (params.gyroTrim && this.haveGyro) {
        if (this.gyroTrimPrev) {
          const trimDelta = this.gyroTrimPrev.clone().invert().multiply(this.gyroQuaternion);
          const scaled = new THREE.Quaternion().identity().slerp(trimDelta, params.gyroTrimStrength);
          this.quaternion.multiply(scaled);
        }
        this.gyroTrimPrev = this.gyroQuaternion.clone();
      } else {
        this.gyroTrimPrev = null;
      }
    }

    if (params.auxInput === "sliders") {
      // Rate control (hold the slider deflected to keep rolling) rather than
      // the finger gesture's position control (twist angle maps directly to
      // roll angle) — a held pose is far easier to sustain than a continuous
      // twisting motion, which runs out of comfortable wrist range fast.
      const rollRate = -this.rollSlider.value * lookRateRad;
      if (rollRate !== 0) {
        const rollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rollRate * delta);
        this.quaternion.multiply(rollQuat);
      }
    } else if (this.pendingRoll !== 0) {
      const rollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.pendingRoll);
      this.quaternion.multiply(rollQuat);
      this.pendingRoll = 0;
    }

    const verticalInput = params.auxInput === "sliders" ? this.verticalSlider.value : this.fingerVerticalInput;
    const thrust = -this.moveStick.value.y;
    const strafe = this.moveStick.value.x;
    const targetVelocity = new THREE.Vector3(strafe, verticalInput, -thrust)
      .multiplyScalar(params.maxSpeed)
      .applyQuaternion(this.quaternion);

    this.velocity.lerp(targetVelocity, 1 - Math.pow(0.001, delta));
    this.position.addScaledVector(this.velocity, delta);
    params.speed = Math.round(this.velocity.length());
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.releasePointer);
    this.canvas.removeEventListener("pointercancel", this.releasePointer);
    window.removeEventListener("deviceorientation", this.handleOrientation);

    this.moveStick.dispose();
    this.lookStick.dispose();
    this.audio.dispose();
    this.verticalIndicator.remove();
    this.verticalSlider.dispose();
    this.rollSlider.dispose();
  }
}
