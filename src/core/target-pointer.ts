import * as THREE from "three";

const MAX_PIXEL_RATIO = 2;
const GREEN = "#22c55e";

// The target must sit inside ±this in NDC on BOTH axes to count as "on screen"
// and get the small diamond marker; past it (or behind the camera) the edge
// chevron takes over. Kept short of ±1 so the marker never crowds the very
// corner where other HUD elements live.
const ON_SCREEN_MARGIN = 0.85;
// Edge chevrons are clamped to this inset rectangle so they never sit under the
// landing HUD (bottom-centre) or the GUI panel.
const EDGE_INSET = 48;

// Per-frame scratch — update() runs every frame and is never re-entrant, so
// module-scope reuse via .copy()/.set() keeps the pointer allocation-free.
const _camPos = new THREE.Vector3();
const _camQuatInv = new THREE.Quaternion();
const _cameraLocal = new THREE.Vector3(); // target in view space (camera-local)
const _ndc = new THREE.Vector3();

/**
 * A full-viewport screen-space cue for a single world-space target. When the
 * target projects on-screen it gets a small open diamond with a label and
 * distance; when it's off-screen or behind you, a bold chevron pins to the
 * viewport edge pointing the shortest way toward it — so "is the pad above or
 * below me" is answered by glancing anywhere on screen.
 */
export class TargetPointer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = window.innerWidth;
  private height = window.innerHeight;
  private ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
  private shown = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "target-pointer";
    this.canvas.style.display = "none";
    document.body.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.resize();
    window.addEventListener("resize", this.onResize);
  }

  private readonly onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.canvas.width = this.width * this.ratio;
    this.canvas.height = this.height * this.ratio;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    // Reset the transform outright (setTransform, not scale) — resize can fire
    // repeatedly and a bare scale() would compound.
    this.ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
  }

  setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.canvas.style.display = visible ? "block" : "none";
  }

  update(camera: THREE.PerspectiveCamera, targetWorld: THREE.Vector3, label: string): void {
    const { ctx, width, height } = this;
    ctx.clearRect(0, 0, width, height);
    if (!this.shown) return;

    // View space = camera-local: the world offset rotated by the inverse camera
    // orientation. camera.position/quaternion are current this frame, whereas
    // camera.matrixWorldInverse only updates at render time, so this derives the
    // projection from live state rather than a stale matrix.
    _camPos.copy(camera.position);
    _camQuatInv.copy(camera.quaternion).invert();
    _cameraLocal.copy(targetWorld).sub(_camPos).applyQuaternion(_camQuatInv);
    const dist = _cameraLocal.length();
    const inFront = _cameraLocal.z < 0; // camera looks down its local -Z

    // Clip -> NDC by feeding the view-space point through the projection matrix
    // (applyMatrix4 does the perspective divide). Only meaningful when in front.
    _ndc.copy(_cameraLocal).applyMatrix4(camera.projectionMatrix);

    if (inFront && Math.abs(_ndc.x) <= ON_SCREEN_MARGIN && Math.abs(_ndc.y) <= ON_SCREEN_MARGIN) {
      const sx = (_ndc.x * 0.5 + 0.5) * width;
      const sy = (0.5 - _ndc.y * 0.5) * height; // NDC +y is up; canvas y is down
      this.drawDiamond(sx, sy, label, dist);
      return;
    }

    // Off-screen or behind: point at the target's screen-plane direction. That
    // plane direction is (x, -y) of the camera-local offset; the camera-local
    // x,y stay correct even when z > 0 (target behind), so the chevron always
    // takes the shortest way around. Dead ahead/behind (x,y ~ 0) has no screen
    // direction, so fall back to up/down by the camera-local y sign.
    let dx = _cameraLocal.x;
    let dy = -_cameraLocal.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-4) {
      dx = 0;
      dy = _cameraLocal.y >= 0 ? -1 : 1;
      len = 1;
    }
    dx /= len;
    dy /= len;
    this.drawChevron(dx, dy, dist);
  }

  private drawDiamond(sx: number, sy: number, label: string, dist: number): void {
    const { ctx } = this;
    const r = 7; // ~10px across
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy - r);
    ctx.lineTo(sx + r, sy);
    ctx.lineTo(sx, sy + r);
    ctx.lineTo(sx - r, sy);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = GREEN;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(label, sx, sy + r + 4);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(`${dist.toFixed(0)}u`, sx, sy + r + 18);
  }

  private drawChevron(dx: number, dy: number, dist: number): void {
    const { ctx, width, height } = this;
    const cx = width / 2;
    const cy = height / 2;
    const halfW = cx - EDGE_INSET;
    const halfH = cy - EDGE_INSET;

    // March from screen centre along (dx,dy) until the first inset edge — the
    // smaller of the two axis scales lands on the rectangle, not past a corner.
    const scaleX = Math.abs(dx) > 1e-4 ? halfW / Math.abs(dx) : Infinity;
    const scaleY = Math.abs(dy) > 1e-4 ? halfH / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    const ex = cx + dx * scale;
    const ey = cy + dy * scale;

    const angle = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(angle);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const s = 16;
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, -s * 0.6);
    ctx.lineTo(s * 0.5, 0); // tip points outward (+x after rotation)
    ctx.lineTo(-s * 0.5, s * 0.6);
    ctx.stroke();
    ctx.restore();

    // Distance sits just inside the chevron, nudged back toward centre.
    ctx.fillStyle = GREEN;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(`${dist.toFixed(0)}u`, cx + dx * (scale - 22), cy + dy * (scale - 22));
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.canvas.remove();
  }
}
