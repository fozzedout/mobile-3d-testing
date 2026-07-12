export type TickCallback = (delta: number, elapsed: number) => void;

/**
 * requestAnimationFrame loop that suspends while the tab/app is hidden,
 * which matters on mobile where background WebGL work drains battery fast.
 */
export class Ticker {
  private rafId: number | null = null;
  private lastTime = 0;
  private elapsed = 0;
  private readonly callbacks = new Set<TickCallback>();

  constructor() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.stop();
      } else {
        this.start();
      }
    });
  }

  add(cb: TickCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  start(): void {
    if (this.rafId !== null || document.hidden) return;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private tick = (time: number): void => {
    const delta = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    this.elapsed += delta;
    for (const cb of this.callbacks) cb(delta, this.elapsed);
    this.rafId = requestAnimationFrame(this.tick);
  };
}
