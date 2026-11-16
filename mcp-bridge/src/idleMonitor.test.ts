import { IdleMonitor } from "./idleMonitor.ts";

describe("IdleMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires when started and never used", () => {
    const onIdle = vi.fn();
    new IdleMonitor(1000, onIdle);

    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("never fires while a lease is held, however long", () => {
    const onIdle = vi.fn();
    const monitor = new IdleMonitor(1000, onIdle);

    monitor.acquire();
    vi.advanceTimersByTime(60_000);

    expect(onIdle).not.toHaveBeenCalled();
    expect(monitor.leaseCount).toBe(1);
  });

  it("counts down from the last release", () => {
    const onIdle = vi.fn();
    const monitor = new IdleMonitor(1000, onIdle);
    monitor.acquire();
    monitor.acquire();

    monitor.release();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();

    monitor.release();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("restarts the countdown on activity when no lease is held", () => {
    const onIdle = vi.fn();
    const monitor = new IdleMonitor(1000, onIdle);

    vi.advanceTimersByTime(800);
    monitor.touch();
    vi.advanceTimersByTime(800);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("ignores activity once it has fired or been stopped", () => {
    const onIdle = vi.fn();
    const monitor = new IdleMonitor(1000, onIdle);
    vi.advanceTimersByTime(1000);
    monitor.touch();
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    const stoppedOnIdle = vi.fn();
    const stopped = new IdleMonitor(1000, stoppedOnIdle);
    stopped.stop();
    stopped.touch();
    vi.advanceTimersByTime(5000);
    expect(stoppedOnIdle).not.toHaveBeenCalled();
  });

  it("throws on a release without a lease", () => {
    const monitor = new IdleMonitor(1000, () => undefined);
    expect(() => monitor.release()).toThrow(/no lease held/);
  });
});
