const SWIPE_THRESHOLD_PX = 28;

/**
 * A triangular wedge fitted into the bottom-left corner — findable by feel
 * (slide a thumb until it hits both physical edges) while tapering away from
 * whatever else occupies that half of the screen (a move stick that can
 * spawn anywhere it's first touched, in every scene that uses this so far).
 * Holding it down fires for as long as it's held (`held`); a swipe up/down
 * additionally locks/unlocks continuous auto-fire (`autoFire`), so a thumb
 * can leave the zone entirely and keep steering while the ship keeps firing.
 * The caller owns cooldown/game-state gating — this just reports intent.
 */
export class FireZone {
  held = false;
  autoFire = false;

  private readonly zone: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private gestureId: number | null = null;
  private gestureStart = { x: 0, y: 0 };

  constructor(container: HTMLElement) {
    this.zone = document.createElement("div");
    this.zone.className = "fire-zone";
    this.zone.innerHTML = '<span class="fire-zone-label">FIRE</span>';
    container.appendChild(this.zone);
    this.label = this.zone.querySelector(".fire-zone-label") as HTMLSpanElement;
    this.setAutoFire(false);

    this.zone.addEventListener("pointerdown", this.onPointerDown);
    this.zone.addEventListener("pointerup", this.onPointerUp);
    this.zone.addEventListener("pointercancel", this.onPointerCancel);
  }

  private setAutoFire(on: boolean): void {
    this.autoFire = on;
    this.zone.classList.toggle("autofire", on);
    this.label.textContent = on ? "AUTO\n↓ stop" : "FIRE\n↑ lock";
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    if (this.gestureId !== null) return;
    this.gestureId = e.pointerId;
    this.gestureStart = { x: e.clientX, y: e.clientY };
    this.held = true;
    // Captured so a fast swipe that overshoots this (deliberately small) box
    // keeps being tracked instead of silently handing off to whatever's
    // underneath — otherwise shrinking the target would break the gesture.
    try {
      this.zone.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a reliability nicety; plain event delivery still works if refused.
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.gestureId) return;
    this.gestureId = null;
    this.held = false;
    const dx = e.clientX - this.gestureStart.x;
    const dy = e.clientY - this.gestureStart.y;
    if (Math.abs(dy) > SWIPE_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
      this.setAutoFire(dy < 0); // swipe up arms it, swipe down disarms it
    }
    // Otherwise: a plain tap/hold already fired via `held` in the caller's update loop.
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.gestureId) this.gestureId = null;
    this.held = false;
  };

  dispose(): void {
    this.zone.removeEventListener("pointerdown", this.onPointerDown);
    this.zone.removeEventListener("pointerup", this.onPointerUp);
    this.zone.removeEventListener("pointercancel", this.onPointerCancel);
    this.zone.remove();
  }
}
