const MAX_PIXEL_RATIO = 2;

/**
 * A live rotation-matching gauge: overlays a "slot" rectangle (the target
 * orientation) and a "ship" rectangle (your current roll) around a shared
 * center, both drawn at their true angles so aligning them is a direct
 * visual task — rotate until the ship rectangle sits inside the slot
 * rectangle — rather than something you only find out after committing.
 */
export class AlignmentHUD {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;
  private readonly height: number;

  constructor(size = 130) {
    this.size = size;
    this.height = size + 22;

    const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "alignment-hud";
    this.canvas.width = size * ratio;
    this.canvas.height = this.height * ratio;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${this.height}px`;
    document.body.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.ctx.scale(ratio, ratio);
  }

  private drawRect(cx: number, cy: number, halfW: number, halfH: number, angle: number, color: string, fill: boolean): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-angle); // canvas rotation is clockwise for +angle; negate to match the math convention used for the angles
    ctx.beginPath();
    ctx.rect(-halfW, -halfH, halfW * 2, halfH * 2);
    if (fill) {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  update(slotAngle: number, shipAngle: number, fits: boolean, label: string): void {
    const { ctx, size } = this;
    const cx = size / 2;
    const cy = size / 2;

    ctx.clearRect(0, 0, size, this.height);

    ctx.beginPath();
    ctx.arc(cx, cy, size / 2 - 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20,22,28,0.75)";
    ctx.fill();
    ctx.strokeStyle = "rgba(154,162,177,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    this.drawRect(cx, cy, size * 0.36, size * 0.11, slotAngle, "#ffd24d", false);
    this.drawRect(cx, cy, size * 0.26, size * 0.08, shipAngle, fits ? "#8fe3a0" : "#ff6b6b", true);

    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = fits ? "#8fe3a0" : "#ff6b6b";
    ctx.fillText(label, cx, size + 14);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
