/**
 * Decides when the bridge daemon has been unused long enough to shut down.
 *
 * A launcher (one per agent session) holds a lease for as long as its process
 * lives. While any lease is held the daemon stays up, however quiet the
 * session. With no leases, the daemon shuts down once `idleMs` passes with no
 * activity (MCP requests from clients that connect over HTTP directly, or
 * canvas traffic).
 */
export class IdleMonitor {
  private readonly idleMs: number;
  private readonly onIdle: () => void;
  private leases = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(idleMs: number, onIdle: () => void) {
    this.idleMs = idleMs;
    this.onIdle = onIdle;
    // a daemon that is started but never used still goes away
    this.schedule();
  }

  get leaseCount(): number {
    return this.leases;
  }

  acquire(): void {
    this.leases += 1;
    this.clear();
  }

  release(): void {
    if (this.leases === 0) {
      throw new Error("IdleMonitor.release() called with no lease held");
    }
    this.leases -= 1;
    this.schedule();
  }

  /** Records activity; restarts the countdown when no lease is held. */
  touch(): void {
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private schedule(): void {
    this.clear();
    if (this.stopped || this.leases > 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stopped = true;
      this.onIdle();
    }, this.idleMs);
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
