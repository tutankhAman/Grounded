import { afterAll, describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { ensureSubscribed } from "./pubsub";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

let redisAvailable = false;
try {
  const probe = new Redis(redisUrl, { lazyConnect: true });
  await probe.connect().catch(() => {
    // Probe connection failure surfaces below via redisAvailable gate.
  });
  await probe.ping();
  await probe.quit();
  redisAvailable = true;
} catch {
  console.warn("⚠️ Skipping pubsub tests: Redis is not reachable.");
}

const makeClient = () =>
  new Redis(redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });

const subscriberCountOnServer = async (
  admin: Redis,
  channel: string
): Promise<number> => {
  const result = (await admin.call("PUBSUB", "NUMSUB", channel)) as unknown[];
  return Number(result[1] ?? 0);
};

describe.skipIf(!redisAvailable)("ensureSubscribed subscription health", () => {
  let admin: Redis;

  afterAll(async () => {
    await admin?.quit().catch(() => {
      // Best-effort test cleanup.
    });
  });

  it("connects a fresh client and confirms the subscription server-side", async () => {
    admin = new Redis(redisUrl, { lazyConnect: true });
    await admin.connect();
    const client = makeClient();
    try {
      // Fresh lazy client starts in "wait" — must still end up subscribed.
      expect(client.status).toBe("wait");
      const ok = await ensureSubscribed(client, "probe:healthy");
      expect(ok).toBe(true);
      expect(await subscriberCountOnServer(admin, "probe:healthy")).toBe(1);
    } finally {
      await client.quit().catch(() => {
        // Best-effort test cleanup.
      });
    }
  });

  it("survives concurrent subscribes while connecting (StrictMode-style race)", async () => {
    const client = makeClient();
    try {
      // Two opens landing on the same tick while the client is mid-connect.
      // Previously the second one failed silently and ghosted the socket.
      const [first, second] = await Promise.all([
        ensureSubscribed(client, "probe:race-a"),
        ensureSubscribed(client, "probe:race-b"),
      ]);
      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(await subscriberCountOnServer(admin, "probe:race-a")).toBe(1);
      expect(await subscriberCountOnServer(admin, "probe:race-b")).toBe(1);
    } finally {
      await client.quit().catch(() => {
        // Best-effort test cleanup.
      });
    }
  });

  it("returns false (never ghosts) on an ended client", async () => {
    const client = makeClient();
    await client.connect();
    await client.quit().catch(() => {
      // Best-effort test cleanup.
    });
    // "end" lands asynchronously after quit resolves.
    await new Promise((r) => setTimeout(r, 300));
    expect(client.status).toBe("end");
    const ok = await ensureSubscribed(client, "probe:dead");
    expect(ok).toBe(false);
    expect(await subscriberCountOnServer(admin, "probe:dead")).toBe(0);
  });
});
