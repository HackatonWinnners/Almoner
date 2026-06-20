// Injectable clock. The demo uses a deterministic advancing clock so tx hashes
// and timestamps are reproducible run-to-run; production passes a real clock.

export interface Clock {
  now(): string;
}

export class FixedClock implements Clock {
  private t: number;
  constructor(startIso = "2026-06-20T09:00:00.000Z", private readonly stepMs = 60_000) {
    this.t = Date.parse(startIso);
  }
  now(): string {
    const iso = new Date(this.t).toISOString();
    this.t += this.stepMs;
    return iso;
  }
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
