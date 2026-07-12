import Stats from "stats.js";

/** Rolling-average FPS text in the topbar, plus an optional detailed Stats.js panel. */
export class FpsMeter {
  private readonly stats = new Stats();
  private frames = 0;
  private windowStart = performance.now();
  private panelVisible = false;

  constructor(private readonly label: HTMLElement) {
    this.stats.dom.style.position = "fixed";
    this.stats.dom.style.top = "calc(env(safe-area-inset-top, 0px) + 48px)";
    this.stats.dom.style.left = "calc(env(safe-area-inset-left, 0px) + 8px)";
    this.stats.dom.style.zIndex = "20";
    this.stats.dom.hidden = true;
    document.body.appendChild(this.stats.dom);

    this.label.addEventListener("click", () => this.togglePanel());
  }

  togglePanel(): void {
    this.panelVisible = !this.panelVisible;
    this.stats.dom.hidden = !this.panelVisible;
  }

  beginFrame(): void {
    this.stats.begin();
  }

  endFrame(): void {
    this.stats.end();
    this.frames += 1;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      const fps = Math.round((this.frames * 1000) / elapsed);
      this.label.textContent = `${fps} fps`;
      this.frames = 0;
      this.windowStart = now;
    }
  }
}
