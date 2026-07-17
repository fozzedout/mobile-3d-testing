const MAX_PIXEL_RATIO = 2;

// Top-down pad view scale: the pad footprint is 20×20 world units, drawn 90px
// square, so 4.5 px per world unit.
const PAD_WORLD = 20;
const PAD_PX = 90;
const PX_PER_U = PAD_PX / PAD_WORLD;
const VEL_PX = 4; // px per u/s for the drift vector
const VEL_MAX_PX = 34; // cap so a fast drift arrow stays inside the view

// Height tape range (world units above the resting point).
const H_MIN = -3;
const H_MAX = 30;

const GREEN = "#8fe3a0";
const AMBER = "#ffd24d";
const RED = "#ff6b6b";
const DIM = "rgba(154,162,177,0.5)";
const FAINT = "rgba(154,162,177,0.25)";
const INK = "rgba(238,241,246,0.9)";

/**
 * A landing gauge drawn ENTIRELY IN THE PAD'S ROTATING LOCAL FRAME — the whole
 * point is that the station's spin is factored out, so "hold the ship
 * motionless on this instrument" literally means rotation-matched with the pad.
 * A ship whose world velocity equals the pad point's velocity (ω × r) reads a
 * near-zero drift vector here even though it is physically moving fast.
 *
 * Left: a top-down view of the pad footprint to scale — ship dot at its offset
 * from pad centre, a drift vector showing relative lateral velocity, and an
 * outline that greens when over the pad and slow, ambers otherwise, reds when
 * badly off. Right: a vertical height tape with the ship marker, a resting-
 * height tick, and the numeric descent rate. A "HOLD" arc fills on touchdown.
 */
export interface LandingInput {
  lateralX: number; // ship offset from pad centre, station-local +x (world units)
  lateralZ: number; // ship offset from pad centre, station-local +z (world units)
  height: number; // ship centre above the resting point (0 = docked/resting)
  relVelX: number; // lateral relative velocity vs the rotating pad, local +x
  relVelZ: number; // lateral relative velocity vs the rotating pad, local +z
  relVelY: number; // vertical relative rate (negative = descending)
  landSpeed: number; // touchdown speed threshold, u/s
  inWindow: boolean; // inside the landing box right now
  holdFrac: number; // 0..1 touchdown-hold progress (0 when not holding)
}

export class LandingHUD {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width = 170;
  private readonly height = 130;
  private shown = false;

  // Top-down pad view centre and clamp radius (px).
  private readonly viewCX = 58;
  private readonly viewCY = 62;
  private readonly viewHalf = 50;
  private readonly padHalfPx = PAD_PX / 2;

  // Height tape geometry (px).
  private readonly tapeX = 132;
  private readonly tapeTop = 16;
  private readonly tapeBottom = 104;
  private readonly tapeW = 12;

  constructor() {
    const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "compass-hud"; // reuses the fixed bottom-center HUD placement
    this.canvas.width = this.width * ratio;
    this.canvas.height = this.height * ratio;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.canvas.style.display = "none"; // hidden until the scene swaps to it
    document.body.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.ctx.scale(ratio, ratio);
  }

  setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.canvas.style.display = visible ? "block" : "none";
  }

  private heightToY(h: number): number {
    const frac = Math.min(Math.max((h - H_MIN) / (H_MAX - H_MIN), 0), 1);
    return this.tapeBottom - frac * (this.tapeBottom - this.tapeTop);
  }

  update(input: LandingInput): void {
    const { ctx, width, height, viewCX, viewCY, viewHalf, padHalfPx } = this;
    const { lateralX, lateralZ, height: shipH, relVelX, relVelZ, relVelY, landSpeed, inWindow, holdFrac } = input;

    ctx.clearRect(0, 0, width, height);

    // Panel.
    ctx.beginPath();
    ctx.roundRect(1, 1, width - 2, height - 2, 8);
    ctx.fillStyle = "rgba(20,22,28,0.75)";
    ctx.fill();
    ctx.strokeStyle = DIM;
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- State: the pad outline greens when over the footprint and slow. ---
    const overFootprint = Math.abs(lateralX) <= PAD_WORLD / 2 && Math.abs(lateralZ) <= PAD_WORLD / 2;
    const totalRel = Math.hypot(relVelX, relVelY, relVelZ);
    const offMag = Math.hypot(lateralX, lateralZ);
    const state = offMag > 25 ? RED : overFootprint && totalRel < landSpeed ? GREEN : AMBER;

    // --- Left: top-down pad footprint (station-local +x → right, +z → down). ---
    ctx.strokeStyle = state;
    ctx.lineWidth = 2;
    ctx.strokeRect(viewCX - padHalfPx, viewCY - padHalfPx, PAD_PX, PAD_PX);

    // Pad centre cross.
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(viewCX - 6, viewCY);
    ctx.lineTo(viewCX + 6, viewCY);
    ctx.moveTo(viewCX, viewCY - 6);
    ctx.lineTo(viewCX, viewCY + 6);
    ctx.stroke();

    // Ship dot at its offset, clamped to the view with an edge-arrow when off.
    const rawX = viewCX + lateralX * PX_PER_U;
    const rawY = viewCY + lateralZ * PX_PER_U;
    const dotX = Math.min(Math.max(rawX, viewCX - viewHalf), viewCX + viewHalf);
    const dotY = Math.min(Math.max(rawY, viewCY - viewHalf), viewCY + viewHalf);
    const offView = rawX !== dotX || rawY !== dotY;

    // Drift vector (relative lateral velocity), scaled and capped.
    let vx = relVelX * VEL_PX;
    let vy = relVelZ * VEL_PX;
    const vlen = Math.hypot(vx, vy);
    if (vlen > VEL_MAX_PX) {
      vx = (vx / vlen) * VEL_MAX_PX;
      vy = (vy / vlen) * VEL_MAX_PX;
    }
    if (vlen > 0.5) {
      ctx.strokeStyle = state;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(dotX, dotY);
      ctx.lineTo(dotX + vx, dotY + vy);
      ctx.stroke();
    }

    if (offView) {
      // Arrow at the clamped position pointing the way the ship really is.
      const ang = Math.atan2(rawY - viewCY, rawX - viewCX);
      ctx.save();
      ctx.translate(dotX, dotY);
      ctx.rotate(ang);
      ctx.fillStyle = state;
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-3, -4);
      ctx.lineTo(-3, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
    }

    // Touchdown-hold arc over the pad view — bold progress feedback.
    if (holdFrac > 0) {
      ctx.beginPath();
      ctx.arc(viewCX, viewCY, padHalfPx + 3, -Math.PI / 2, -Math.PI / 2 + Math.min(holdFrac, 1) * Math.PI * 2);
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = GREEN;
      ctx.fillText("HOLD", viewCX, viewCY - padHalfPx - 10);
    }

    // --- Right: vertical height tape (0 = resting up to ~30u). ---
    const { tapeX, tapeTop, tapeBottom, tapeW } = this;
    ctx.strokeStyle = DIM;
    ctx.lineWidth = 1;
    ctx.strokeRect(tapeX, tapeTop, tapeW, tapeBottom - tapeTop);

    // Resting-height tick (h = 0) — greens while inside the landing window.
    const restY = this.heightToY(0);
    ctx.strokeStyle = inWindow ? GREEN : FAINT;
    ctx.lineWidth = inWindow ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(tapeX - 3, restY);
    ctx.lineTo(tapeX + tapeW + 3, restY);
    ctx.stroke();

    // Ship marker (triangle pointing into the tape from the left).
    const shipY = this.heightToY(shipH);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(tapeX - 2, shipY);
    ctx.lineTo(tapeX - 9, shipY - 4);
    ctx.lineTo(tapeX - 9, shipY + 4);
    ctx.closePath();
    ctx.fill();

    // Descent rate readout (one decimal, negative = descending).
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = Math.abs(relVelY) > landSpeed ? RED : INK;
    ctx.fillText(`${relVelY.toFixed(1)} u/s`, tapeX + tapeW / 2, tapeBottom + 16);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
