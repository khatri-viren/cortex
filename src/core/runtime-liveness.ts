export type RuntimeLease = { expires: number; session?: string };
export const RUNTIME_LEASE_MS = 45_000;

/** Lease expiry must distinguish an absent client from a suspended machine. */
export class ClientLiveness {
  readonly leases = new Map<string, RuntimeLease>();
  private lastSweep: number;
  constructor(now = Date.now()) { this.lastSweep = now; }

  renew(id: string, now = Date.now()): RuntimeLease {
    const lease = this.leases.get(id) ?? { expires: 0 };
    lease.expires = now + RUNTIME_LEASE_MS;
    this.leases.set(id, lease);
    return lease;
  }

  sweep(now = Date.now()): { resumed: boolean; expired: RuntimeLease[] } {
    const resumed = now - this.lastSweep > RUNTIME_LEASE_MS;
    this.lastSweep = now;
    // Give bridges a complete renewal window after sleep or a delayed event
    // loop. Timer ordering on resume must not disconnect healthy clients.
    if (resumed) {
      for (const lease of this.leases.values()) lease.expires = now + RUNTIME_LEASE_MS;
      return { resumed: true, expired: [] };
    }
    const expired: RuntimeLease[] = [];
    for (const [id, lease] of this.leases) if (lease.expires < now) {
      this.leases.delete(id);
      expired.push(lease);
    }
    return { resumed: false, expired };
  }
}
