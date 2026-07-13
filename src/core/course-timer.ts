export type CourseState = "countdown" | "racing" | "finished";

function formatMs(ms: number): string {
  const totalSeconds = Math.max(ms, 0) / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export interface CourseTimerOptions {
  countdownSeconds?: number;
  /** If set, the best finish time persists across visits via localStorage. */
  storageKey?: string;
}

/**
 * Countdown -> racing -> finished state machine shared by all timed
 * courses. Fields are plain mutable strings/numbers (not getters) so
 * lil-gui's `.listen()` polling can bind to them directly.
 */
export class CourseTimer {
  state: CourseState = "countdown";
  statusText = "Get ready…";
  timeText = "0:00.00";
  bestText = "—";
  hits = 0;

  private elapsedMs = 0;
  private penaltyMs = 0;
  private countdownRemaining: number;
  private readonly countdownSeconds: number;
  private readonly storageKey?: string;
  private bestMs: number | null = null;

  constructor(opts: CourseTimerOptions = {}) {
    this.countdownSeconds = opts.countdownSeconds ?? 3;
    this.countdownRemaining = this.countdownSeconds;
    this.storageKey = opts.storageKey;
    if (this.storageKey) {
      const stored = Number(localStorage.getItem(this.storageKey));
      if (Number.isFinite(stored) && stored > 0) {
        this.bestMs = stored;
        this.bestText = formatMs(stored);
      }
    }
  }

  get active(): boolean {
    return this.state === "racing";
  }

  update(delta: number): void {
    if (this.state === "countdown") {
      this.countdownRemaining -= delta;
      if (this.countdownRemaining > 0) {
        this.statusText = `${Math.ceil(this.countdownRemaining)}…`;
      } else {
        this.state = "racing";
        this.elapsedMs = 0;
        this.penaltyMs = 0;
        this.hits = 0;
        this.statusText = "Go!";
      }
    } else if (this.state === "racing") {
      this.elapsedMs += delta * 1000;
      this.timeText = formatMs(this.elapsedMs + this.penaltyMs);
    }
  }

  addPenalty(ms: number): void {
    if (this.state !== "racing") return;
    this.penaltyMs += ms;
    this.hits += 1;
  }

  finish(): void {
    if (this.state !== "racing") return;
    const total = this.elapsedMs + this.penaltyMs;
    this.state = "finished";
    this.timeText = formatMs(total);
    this.statusText = this.hits > 0 ? `Finished — ${this.hits} hit${this.hits === 1 ? "" : "s"}` : "Finished!";
    if (this.storageKey && (this.bestMs === null || total < this.bestMs)) {
      this.bestMs = total;
      this.bestText = `${formatMs(total)} (new best)`;
      localStorage.setItem(this.storageKey, String(total));
    }
  }

  restart(): void {
    this.state = "countdown";
    this.countdownRemaining = this.countdownSeconds;
    this.elapsedMs = 0;
    this.penaltyMs = 0;
    this.hits = 0;
    this.statusText = "Get ready…";
    this.timeText = "0:00.00";
    if (this.bestMs !== null) this.bestText = formatMs(this.bestMs);
  }
}
