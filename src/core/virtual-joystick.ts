import { AudioClicker } from "./audio-ticks.ts";

export interface VirtualJoystickOptions {
  /** Hard visual cap, in px, past which the knob can't be dragged further. */
  radius?: number;
  /** Px radius up to which input maps linearly; beyond this, pseudo-haptic log dampening kicks in. */
  softLimit?: number;
  /** Px radius of the dead zone around home. */
  deadZone?: number;
  /** Px spacing between audio "detent" clicks while dragging. */
  notchSpacing?: number;
  color?: string;
  audio?: AudioClicker | null;
}

/**
 * A floating joystick: spawns wherever `show()` is called (touch-down point),
 * so there's no fixed on-screen real estate to run out of, and lifting the
 * finger (`hide()`) acts as an instant clutch with zero residual momentum.
 * Feed it raw pixel deltas from the touch-down point via `feed()`.
 */
export class VirtualJoystick {
  value = { x: 0, y: 0 };
  audioEnabled = true;

  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly radius: number;
  private readonly softLimit: number;
  private readonly deadZone: number;
  private readonly notchSpacing: number;
  private readonly audio: AudioClicker | null;
  private lastNotch = 0;
  private thudFired = false;

  constructor(container: HTMLElement, opts: VirtualJoystickOptions = {}) {
    this.radius = opts.radius ?? 55;
    this.softLimit = opts.softLimit ?? 34;
    this.deadZone = opts.deadZone ?? 6;
    this.notchSpacing = opts.notchSpacing ?? 14;
    this.audio = opts.audio ?? null;

    this.base = document.createElement("div");
    this.base.className = "stick-base";
    this.base.style.borderColor = opts.color ?? "#4da3ff";
    this.base.hidden = true;

    this.knob = document.createElement("div");
    this.knob.className = "stick-knob";
    this.knob.style.background = opts.color ?? "#4da3ff";

    this.base.appendChild(this.knob);
    container.appendChild(this.base);
  }

  show(x: number, y: number): void {
    this.base.hidden = false;
    this.base.style.left = `${x - this.radius}px`;
    this.base.style.top = `${y - this.radius}px`;
    this.base.style.width = `${this.radius * 2}px`;
    this.base.style.height = `${this.radius * 2}px`;
    this.knob.style.transform = "translate(-50%, -50%)";
    this.lastNotch = 0;
    this.thudFired = false;
  }

  hide(): void {
    this.base.hidden = true;
    this.value.x = 0;
    this.value.y = 0;
  }

  /** dx/dy are raw pixel deltas from the touch-down point. */
  feed(dx: number, dy: number): void {
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    let mapped: number;
    if (dist <= this.deadZone) {
      mapped = 0;
    } else if (dist <= this.softLimit) {
      mapped = (dist - this.deadZone) / (this.softLimit - this.deadZone);
    } else {
      // Pseudo-haptic wall: past the soft limit, extra finger travel yields
      // logarithmically diminishing output, asymptoting toward the max —
      // the finger keeps moving freely but the on-screen response hits a "wall".
      const over = dist - this.softLimit;
      const range = Math.max(this.radius - this.softLimit, 1);
      mapped = 1 + Math.log1p(over / range) * 0.35;
    }
    const outputMag = Math.min(mapped, 1);

    this.value.x = Math.cos(angle) * outputMag;
    this.value.y = Math.sin(angle) * outputMag;

    const knobDist = Math.min(dist, this.radius * 0.92);
    const kx = Math.cos(angle) * knobDist;
    const ky = Math.sin(angle) * knobDist;
    this.knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

    if (this.audio && this.audioEnabled) {
      const notch = Math.floor(dist / this.notchSpacing);
      if (notch !== this.lastNotch && dist > this.deadZone) {
        this.audio.click(0.4 + outputMag);
        this.lastNotch = notch;
      }
      if (outputMag >= 0.98 && !this.thudFired) {
        this.audio.thud();
        this.thudFired = true;
      } else if (outputMag < 0.9) {
        this.thudFired = false;
      }
    }
  }

  dispose(): void {
    this.base.remove();
  }
}
