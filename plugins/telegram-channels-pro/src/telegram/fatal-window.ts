export class FatalWindow {
  private timestamps: number[] = [];
  constructor(public windowMs: number = 60_000, public threshold: number = 5) {}

  record(ts: number): void {
    const cutoff = ts - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    this.timestamps.push(ts);
  }

  tripped(nowTs: number): boolean {
    const cutoff = nowTs - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    return this.timestamps.length >= this.threshold;
  }

  count(): number {
    return this.timestamps.length;
  }

  reset(): void {
    this.timestamps = [];
  }
}
