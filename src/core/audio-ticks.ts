/**
 * Synthesizes short click/thud transients as a pseudo-haptic proxy — iOS Safari
 * blocks web-page access to the Taptic Engine, so a sharp audio transient is
 * used instead to signal a detent or hard limit (the audio-tactile illusion).
 */
export class AudioClicker {
  private ctx: AudioContext | null = null;

  private ensureContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private tone(freqStart: number, freqEnd: number, duration: number, gain: number): void {
    const ctx = this.ensureContext();
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = "sine";
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), now + duration);
    gainNode.gain.setValueAtTime(gain, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gainNode).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  /** A quick high-to-low chirp, like a notched dial passing a detent. */
  click(intensity = 1): void {
    this.tone(2000, 200, 0.008, 0.05 * Math.min(intensity, 1));
  }

  /** A duller, longer thud for hitting a hard limit. */
  thud(): void {
    this.tone(180, 40, 0.05, 0.16);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
