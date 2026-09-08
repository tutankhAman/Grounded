import { resolve } from "node:path";
import { waitForRedisReady } from "@grounded/db";
import dotenv from "dotenv";
import Redis from "ioredis";
import { isTerminalStatus } from "./events";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const subRedis = new Redis(redisUrl, {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

export interface WebSocketClient {
  close: (code?: number, reason?: string) => void;
  id?: string;
  send: (data: string) => void;
}

const subscribers = new Map<
  string,
  Map<string | WebSocketClient, WebSocketClient>
>();

/**
 * Channels with a CONFIRMED Redis subscription. The in-memory socket map and
 * this set are kept in sync: a channel is only ever added here after Redis
 * acknowledges SUBSCRIBE, so a failed subscribe can never leave a ghost
 * registration that receives nothing forever.
 */
const subscribedChannels = new Set<string>();

let listenersRegistered = false;

const isTerminalPayload = (message: string): boolean => {
  try {
    const payload = JSON.parse(message) as { status?: unknown };
    return isTerminalStatus(payload.status);
  } catch {
    // Non-JSON payload: forward as-is, keep existing behavior.
    return false;
  }
};

const deliverToClients = (
  documentId: string,
  message: string,
  terminal: boolean
): void => {
  const clientsMap = subscribers.get(documentId);
  if (!clientsMap || clientsMap.size === 0) {
    return;
  }

  for (const [key, client] of clientsMap) {
    try {
      client.send(message);
      if (terminal) {
        try {
          client.close(1000, "Document reached terminal state");
        } catch {
          // Already gone — pruned below.
        }
        clientsMap.delete(key);
      }
    } catch {
      // Drop unreachable client
      clientsMap.delete(key);
    }
  }

  if (clientsMap.size === 0) {
    subscribers.delete(documentId);
    dropChannelSubscription(documentId);
  }
};

const dropChannelSubscription = async (documentId: string): Promise<void> => {
  const channel = `doc:${documentId}:status`;
  subscribedChannels.delete(channel);
  await subRedis.unsubscribe(channel).catch(() => {
    // Ignored: best-effort unsubscription
  });
};

const resubscribeTrackedChannels = (): void => {
  if (subscribedChannels.size === 0) {
    return;
  }
  for (const channel of subscribedChannels) {
    // Belt and suspenders over ioredis auto-resubscribe: a duplicate
    // SUBSCRIBE is idempotent and harmless, a missed one is a silent stall.
    subRedis.subscribe(channel).catch((err: unknown) => {
      console.warn(`[pubsub] resubscribe failed for ${channel}:`, err);
    });
  }
};

const ensureMessageListener = (): void => {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;

  subRedis.on("message", (channel: string, message: string) => {
    // Channel format: doc:<id>:status
    if (!(channel.startsWith("doc:") && channel.endsWith(":status"))) {
      return;
    }
    const documentId = channel.slice(4, -7);
    deliverToClients(documentId, message, isTerminalPayload(message));
  });

  subRedis.on("ready", () => {
    resubscribeTrackedChannels();
  });

  subRedis.on("error", (err: unknown) => {
    console.warn(
      "[pubsub] subscriber connection error:",
      err instanceof Error ? err.message : err
    );
  });
};

/**
 * Ensures a CONFIRMED Redis subscription for the channel. Returns true only
 * if Redis acknowledged SUBSCRIBE. Never throws — callers treat false as
 * "live updates unavailable" and surface it instead of ghosting the socket.
 *
 * Takes the client as a parameter (rather than using the module singleton)
 * so the failure paths are unit-testable with throwaway clients.
 */
export const ensureSubscribed = async (
  client: Redis,
  channel: string
): Promise<boolean> => {
  try {
    // Kick off a connection if there isn't one in flight. Do NOT call
    // connect() while already connecting — ioredis rejects that — just wait
    // for the in-flight attempt (covers concurrent socket opens on the same
    // tick, e.g. several document rows mounting at once).
    if (client.status === "wait" || client.status === "close") {
      client.connect().catch(() => {
        // Readiness is verified below; a failed kickoff just means waiting.
      });
    }
    if (!(await waitForRedisReady(client))) {
      console.warn(
        `[pubsub] subscribe aborted for ${channel}: client not ready (status=${client.status})`
      );
      return false;
    }
    // Always issue SUBSCRIBE (idempotent server-side) rather than trusting
    // local state: only a Redis acknowledgment proves delivery will work.
    await client.subscribe(channel);
    subscribedChannels.add(channel);
    return true;
  } catch (err: unknown) {
    console.warn(
      `[pubsub] subscribe failed for ${channel}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
};

export const subscribeToDocument = async (
  documentId: string,
  ws: WebSocketClient
): Promise<boolean> => {
  ensureMessageListener();

  const channel = `doc:${documentId}:status`;
  // Register the socket ONLY after Redis confirms the subscription.
  // Registering first is how ghost subscriptions happen: a failed SUBSCRIBE
  // (e.g. issued while the client is still connecting, with the offline
  // queue disabled) used to leave the socket in the map forever, receiving
  // nothing with no error shown.
  if (!(await ensureSubscribed(subRedis, channel))) {
    return false;
  }

  let map = subscribers.get(documentId);
  if (!map) {
    map = new Map();
    subscribers.set(documentId, map);
  }
  const key = ws.id ?? ws;
  map.set(key, ws);
  return true;
};

export const unsubscribeFromDocument = async (
  documentId: string,
  ws: WebSocketClient
): Promise<void> => {
  const map = subscribers.get(documentId);
  if (!map) {
    return;
  }

  const key = ws.id ?? ws;
  map.delete(key);
  if (map.size === 0) {
    subscribers.delete(documentId);
    await dropChannelSubscription(documentId);
  }
};

export const getSubscriberCount = (documentId: string): number =>
  subscribers.get(documentId)?.size ?? 0;

export const closePubSub = async (): Promise<void> => {
  subscribers.clear();
  subscribedChannels.clear();
  if (subRedis.status !== "end") {
    await subRedis.quit().catch(() => {
      subRedis.disconnect();
    });
  }
};
