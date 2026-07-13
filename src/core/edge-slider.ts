export interface EdgeSliderOptions {
  side: "left" | "right";
  /** Extra shift away from the edge, in px — lets two sliders sit side by side. */
  offsetPx?: number;
  color?: string;
  trackHeight?: number; // px
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * A persistent, always-visible vertical slider fixed to a screen edge —
 * touching anywhere on its track jumps the handle there (absolute position,
 * not a delta from touch-down), and releasing springs it back to center.
 * Unlike a multi-touch gesture (twist-to-roll, a second finger dragged),
 * holding it at a deflection is a static pose, not a continuous motion, so
 * it's far easier to sustain a constant rate for more than a moment.
 */
export class EdgeSlider {
  value = 0; // -1 (bottom) .. 1 (top)

  private readonly track: HTMLDivElement;
  private readonly handle: HTMLDivElement;
  private activePointerId: number | null = null;

  constructor(container: HTMLElement, opts: EdgeSliderOptions) {
    const trackHeight = opts.trackHeight ?? 160;
    const offset = opts.offsetPx ?? 0;
    this.track = document.createElement("div");
    this.track.className = "edge-slider";
    this.track.style.height = `${trackHeight}px`;
    this.track.style.borderColor = opts.color ?? "#4da3ff";
    if (opts.side === "left") {
      this.track.style.left = `calc(var(--safe-left) + ${8 + offset}px)`;
    } else {
      this.track.style.right = `calc(var(--safe-right) + ${8 + offset}px)`;
    }

    this.handle = document.createElement("div");
    this.handle.className = "edge-slider-handle";
    this.handle.style.background = opts.color ?? "#4da3ff";
    this.track.appendChild(this.handle);

    container.appendChild(this.track);
    this.updateHandle();
  }

  setVisible(visible: boolean): void {
    this.track.hidden = !visible;
    if (!visible) this.forceRelease();
  }

  get isActive(): boolean {
    return this.activePointerId !== null;
  }

  /** Claims the pointer if it landed within (or just past) the track's bounds. */
  tryClaim(pointerId: number, clientX: number, clientY: number): boolean {
    if (this.track.hidden || this.activePointerId !== null) return false;
    const rect = this.track.getBoundingClientRect();
    const margin = 8; // small — two sliders now sit close together on the same edge
    if (clientX < rect.left - margin || clientX > rect.right + margin || clientY < rect.top || clientY > rect.bottom) {
      return false;
    }
    this.activePointerId = pointerId;
    this.setFromClientY(clientY, rect);
    return true;
  }

  feed(pointerId: number, clientY: number): boolean {
    if (pointerId !== this.activePointerId) return false;
    this.setFromClientY(clientY);
    return true;
  }

  release(pointerId: number): boolean {
    if (pointerId !== this.activePointerId) return false;
    this.forceRelease();
    return true;
  }

  /** Unconditionally clears any active touch and springs back to center. */
  forceReset(): void {
    this.forceRelease();
  }

  private forceRelease(): void {
    this.activePointerId = null;
    this.value = 0;
    this.updateHandle();
  }

  private setFromClientY(clientY: number, rect: DOMRect = this.track.getBoundingClientRect()): void {
    const t = clamp((clientY - rect.top) / rect.height, 0, 1); // 0 at top, 1 at bottom
    this.value = 1 - t * 2; // top -> 1, center -> 0, bottom -> -1
    this.updateHandle();
  }

  private updateHandle(): void {
    const pct = (1 - (this.value + 1) / 2) * 100;
    this.handle.style.top = `${pct}%`;
  }

  dispose(): void {
    this.track.remove();
  }
}
