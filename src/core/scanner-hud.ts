import * as THREE from "three";

export interface ScannerTarget {
  label: string;
  color: string;
  position: THREE.Vector3;
}

const MAX_PIXEL_RATIO = 2;
const DISC_SQUASH = 0.42; // flattens the disc into an ellipse to read as a horizontal plane
const MAX_STALK_PX = 40;

/**
 * A classic Elite-style 3D scanner: a tilted disc (an ellipse, to suggest a
 * horizontal plane) shows each target's bearing and range as a dot's polar
 * position, and a vertical "stalk" connects that dot to its ground-plane
 * shadow — stalk going up means the target is above you, down means below —
 * so bearing, range, and altitude can all be read from one glance instead of
 * just bearing (which is all a flat compass ring can show).
 */
export class ScannerHUD {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly diameter: number;
  private readonly width: number;
  private readonly height: number;
  private readonly range: number;

  constructor(diameter = 150, range = 220) {
    this.diameter = diameter;
    this.range = range;
    this.width = diameter;
    this.height = diameter + 34;

    const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "compass-hud"; // reuses the fixed bottom-center HUD placement
    this.canvas.width = this.width * ratio;
    this.canvas.height = this.height * ratio;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    document.body.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.ctx.scale(ratio, ratio);
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? "block" : "none";
  }

  update(shipPosition: THREE.Vector3, shipQuaternion: THREE.Quaternion, targets: ScannerTarget[]): void {
    const { ctx, width, diameter, range } = this;
    const cx = width / 2;
    const cy = diameter / 2;
    const discRadiusX = diameter / 2 - 10;
    const discRadiusY = discRadiusX * DISC_SQUASH;

    ctx.clearRect(0, 0, this.width, this.height);

    ctx.beginPath();
    ctx.ellipse(cx, cy, discRadiusX, discRadiusY, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20,22,28,0.75)";
    ctx.fill();
    ctx.strokeStyle = "rgba(154,162,177,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - discRadiusX, cy);
    ctx.lineTo(cx + discRadiusX, cy);
    ctx.moveTo(cx, cy - discRadiusY);
    ctx.lineTo(cx, cy + discRadiusY);
    ctx.strokeStyle = "rgba(154,162,177,0.25)";
    ctx.stroke();

    // Ship marker at the scanner's origin.
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(238,241,246,0.9)";
    ctx.fill();

    const inverseQuat = shipQuaternion.clone().invert();
    const labels: { text: string; color: string }[] = [];

    for (const target of targets) {
      const local = target.position.clone().sub(shipPosition).applyQuaternion(inverseQuat);
      const distance = local.length();

      const scale = discRadiusX / range;
      let dx = local.x * scale;
      let dz = local.z * DISC_SQUASH * scale; // forward(-Z)/behind onto the squashed depth axis

      const norm = Math.hypot(dx / discRadiusX, dz / discRadiusY);
      if (norm > 1) {
        dx /= norm;
        dz /= norm;
      }

      const shadowX = cx + dx;
      const shadowY = cy + dz;
      const stalk = THREE.MathUtils.clamp((-local.y * discRadiusX) / range, -MAX_STALK_PX, MAX_STALK_PX);
      const blipY = shadowY + stalk;

      ctx.beginPath();
      ctx.moveTo(shadowX, shadowY);
      ctx.lineTo(shadowX, blipY);
      ctx.strokeStyle = target.color;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(shadowX, shadowY, 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(154,162,177,0.6)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(shadowX, blipY, 4, 0, Math.PI * 2);
      ctx.fillStyle = target.color;
      ctx.fill();

      labels.push({ text: `${target.label} ${Math.round(distance)}m`, color: target.color });
    }

    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    labels.forEach((l, i) => {
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, cx, diameter + 14 + i * 14);
    });
  }

  dispose(): void {
    this.canvas.remove();
  }
}
