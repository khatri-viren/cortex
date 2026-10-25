import { expect, test } from "bun:test";
import { ClientLiveness, RUNTIME_LEASE_MS } from "../src/core/runtime-liveness.js";

test("long system suspension gives live clients time to renew before expiring sessions", () => {
  const clock = new ClientLiveness(0);
  clock.renew("agent", 0).session = "session-1";
  expect(clock.sweep(1000).expired).toHaveLength(0);
  const wake = 60 * 60 * 1000;
  expect(clock.sweep(wake)).toEqual({ resumed: true, expired: [] });
  // Owner's timer fires before the bridge's timer after a one-hour sleep.
  expect(clock.leases.get("agent")?.expires).toBe(wake + RUNTIME_LEASE_MS);
  clock.renew("agent", wake + 10_000);
  expect(clock.sweep(wake + 20_000).expired).toHaveLength(0);
  expect(clock.leases.get("agent")?.session).toBe("session-1");
});

test("a crashed client still expires after the post-resume renewal window", () => {
  const clock = new ClientLiveness(0);
  clock.renew("crashed", 0).session = "orphan-session";
  const wake = 3_600_000;
  clock.sweep(wake);
  for (let time = wake + 1000; time < wake + RUNTIME_LEASE_MS; time += 1000) expect(clock.sweep(time).expired).toHaveLength(0);
  expect(clock.sweep(wake + RUNTIME_LEASE_MS + 1).expired).toEqual([{ expires: wake + RUNTIME_LEASE_MS, session: "orphan-session" }]);
  expect(clock.leases.size).toBe(0);
});
