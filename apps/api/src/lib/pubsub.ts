import { resolve } from "node:path";
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
let messageListenerRegistered = false;

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
    subRedis.unsubscribe(`doc:${documentId}:status`).catch(() => {
      // Ignored: best-effort unsubscription
    });
  }
};

const ensureMessageListener = (): void => {
  if (messageListenerRegistered) {
    return;
  }
  messageListenerRegistered = true;

  subRedis.on("message", (channel: string, message: string) => {
    // Channel format: doc:<id>:status
    if (!(channel.startsWith("doc:") && channel.endsWith(":status"))) {
      return;
    }
    const documentId = channel.slice(4, -7);
    deliverToClients(documentId, message, isTerminalPayload(message));
  });
};

export const subscribeToDocument = async (
  documentId: string,
  ws: WebSocketClient
): Promise<void> => {
  ensureMessageListener();

  if (subRedis.status === "wait") {
    await subRedis.connect().catch(() => {
      // Ignored: best-effort connection
    });
  }

  let map = subscribers.get(documentId);
  const isFirst = !map || map.size === 0;
  if (!map) {
    map = new Map();
    subscribers.set(documentId, map);
  }
  const key = ws.id ?? ws;
  map.set(key, ws);

  if (isFirst) {
    await subRedis.subscribe(`doc:${documentId}:status`).catch(() => {
      // Ignored: best-effort subscription
    });
  }
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
    await subRedis.unsubscribe(`doc:${documentId}:status`).catch(() => {
      // Ignored: best-effort unsubscription
    });
  }
};

export const getSubscriberCount = (documentId: string): number =>
  subscribers.get(documentId)?.size ?? 0;

export const closePubSub = async (): Promise<void> => {
  subscribers.clear();
  if (subRedis.status !== "end") {
    await subRedis.quit().catch(() => {
      subRedis.disconnect();
    });
  }
};
