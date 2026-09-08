import type Redis from "ioredis";

/**
 * Waits until an ioredis client is ready (or gives up). Never throws.
 *
 * Why this exists: with `enableOfflineQueue: false`, any command issued
 * while the client is still connecting is REJECTED immediately — and
 * `connect()` itself rejects with "already connecting/connected" if another
 * call is establishing the connection concurrently (e.g. several sockets
 * opening on the same tick, or a reconnect in flight). Callers must therefore
 * wait for readiness instead of firing commands optimistically; a failed
 * command here used to be swallowed, leaving ghost subscriptions and lost
 * progress events with zero errors shown.
 *
 * @returns true if the client is ready (or became ready within timeoutMs).
 */
export const waitForRedisReady = (
  client: Redis,
  timeoutMs = 5000
): Promise<boolean> =>
  new Promise((resolve) => {
    if (client.status === "ready") {
      resolve(true);
      return;
    }
    if (client.status === "end") {
      // Dead client (quit/disconnect called): will never become ready.
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      client.removeListener("ready", onReady);
      resolve(client.status === "ready");
    }, timeoutMs);
    const onReady = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    client.once("ready", onReady);
  });
