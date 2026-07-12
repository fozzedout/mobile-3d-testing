import * as THREE from "three";

export interface CompassTarget {
  label: string;
  color: string;
  position: THREE.Vector3;
}

const MAX_PIXEL_RATIO = 2;

/**
 * A bearing/deviation compass, drawn as a ring: a target's distance from the
 * ring's center encodes its angular deviation from dead-ahead (center = right
 * in your crosshair, edge = 90°+ off-axis), and its angle around the ring
 * matches the on-screen direction you'd turn to face it. Targets behind you
 * still resolve to a (less precise) edge position, drawn dashed/faded.
 */
export class CompassHUD {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly diameter: number;
  private readonly width: number;
  private readonly height: number;
  private readonly prevDeviation = new Map<string, number>();

  constructor(diameter = 120) {
    this.diameter = diameter;
    this.width = diameter;
    this.height = diameter + 34;

    const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "compass-hud";
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

  update(camera: THREE.Camera, targets: CompassTarget[], delta = 0): void {
    const { ctx, width, diameter } = this;
    const cx = width / 2;
    const cy = diameter / 2;
    const ringRadius = diameter / 2 - 10;

    ctx.clearRect(0, 0, this.width, this.height);

    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20,22,28,0.75)";
    ctx.fill();
    ctx.strokeStyle = "rgba(154,162,177,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Center reticle = dead-ahead reference.
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.strokeStyle = "rgba(238,241,246,0.6)";
    ctx.stroke();

    camera.updateMatrixWorld();
    const inverse = camera.matrixWorldInverse;
    const labels: { text: string; color: string; rateText: string; rateColor: string }[] = [];

    for (const target of targets) {
      const camSpace = target.position.clone().applyMatrix4(inverse);
      const distance = camSpace.length();
      if (distance < 0.001) continue;

      const dir = camSpace.clone().divideScalar(distance);
      const forwardComponent = THREE.MathUtils.clamp(-dir.z, -1, 1);
      const deviation = Math.acos(forwardComponent); // 0 = dead ahead, PI = dead behind
      const bearing = Math.atan2(dir.y, dir.x);
      const behind = deviation > Math.PI / 2;

      const r = Math.min(deviation / (Math.PI / 2), 1) * ringRadius;
      const mx = cx + Math.cos(bearing) * r;
      const my = cy - Math.sin(bearing) * r;

      ctx.beginPath();
      ctx.arc(mx, my, 5, 0, Math.PI * 2);
      ctx.fillStyle = target.color;
      ctx.globalAlpha = behind ? 0.45 : 1;
      ctx.fill();
      if (behind) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = target.color;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Closing-rate cue: how fast this target's bearing is converging on
      // dead-ahead, so you can anticipate an overshoot before it happens
      // rather than only noticing after you've already sailed past it.
      const deviationDeg = THREE.MathUtils.radToDeg(deviation);
      let rateText = "";
      let rateColor = "rgba(154,162,177,0.7)";
      const prevDeg = this.prevDeviation.get(target.label);
      if (prevDeg !== undefined && delta > 0) {
        const closingRate = (prevDeg - deviationDeg) / delta; // deg/sec, positive = converging on boresight
        const magnitude = Math.round(Math.abs(closingRate));
        if (closingRate > 60) {
          rateColor = "#ff6b6b";
          rateText = ` ▼▼${magnitude}°/s`;
        } else if (closingRate > 15) {
          rateColor = "#8fe3a0";
          rateText = ` ▼${magnitude}°/s`;
        } else if (closingRate < -15) {
          rateText = ` ▲${magnitude}°/s`;
        }
      }
      this.prevDeviation.set(target.label, deviationDeg);

      labels.push({ text: `${target.label} ${Math.round(distance)}m`, color: target.color, rateText, rateColor });
    }

    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    labels.forEach((l, i) => {
      const y = diameter + 14 + i * 14;
      const mainWidth = ctx.measureText(l.text).width;
      const rateWidth = l.rateText ? ctx.measureText(l.rateText).width : 0;
      const startX = cx - (mainWidth + rateWidth) / 2;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, startX, y);
      if (l.rateText) {
        ctx.fillStyle = l.rateColor;
        ctx.fillText(l.rateText, startX + mainWidth, y);
      }
    });
  }

  dispose(): void {
    this.canvas.remove();
  }
}
