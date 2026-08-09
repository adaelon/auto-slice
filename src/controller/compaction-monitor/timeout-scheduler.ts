import type { Clock, DeadlineScheduler } from "./types.js";

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class TimeoutDeadlineScheduler implements DeadlineScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  public constructor(private readonly clock: Clock = new SystemClock()) {}

  public schedule(key: string, deadline: Date, callback: () => void): void {
    this.cancel(key);
    const delay = Math.max(0, deadline.getTime() - this.clock.now().getTime());
    const timer = setTimeout(() => {
      this.timers.delete(key);
      callback();
    }, delay);
    this.timers.set(key, timer);
  }

  public cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
