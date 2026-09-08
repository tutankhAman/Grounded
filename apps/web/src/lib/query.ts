import { QueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 10,
    },
  },
});

export const queryKeys = {
  document: (id: string) => ["documents", id] as const,
  documentChunks: (id: string, params?: Record<string, unknown>) =>
    ["documents", id, "chunks", params] as const,
  documents: () => ["documents"] as const,
  entities: (params?: Record<string, unknown>) => ["entities", params] as const,
  entity: (id: string) => ["entities", id] as const,
  fact: (id: string) => ["facts", id] as const,
  factRelationships: (id: string) => ["facts", id, "relationships"] as const,
  facts: (filters?: Record<string, unknown>) => ["facts", filters] as const,
  health: ["health"] as const,
  relationship: (id: string) => ["relationships", id] as const,
  relationships: (params?: Record<string, unknown>) =>
    ["relationships", params] as const,
};

export interface NormalizedPagination {
  limit: number;
  page: number;
  total: number;
  totalPages: number;
}

export interface NormalizedList<T> {
  data: T[];
  pagination: NormalizedPagination;
}

function extractError(res: { error?: unknown; data?: unknown }): Error {
  if (res.error) {
    const errObj = res.error as { value?: unknown };
    if (typeof errObj === "object" && "value" in errObj) {
      const v = errObj.value;
      if (typeof v === "string") {
        return new Error(v);
      }
      if (v && typeof v === "object" && "error" in v) {
        return new Error(String((v as { error: unknown }).error));
      }
      return new Error(JSON.stringify(v));
    }
    return new Error(String(res.error));
  }
  if (res.data && typeof res.data === "object" && "error" in res.data) {
    return new Error(String((res.data as { error: unknown }).error));
  }
  return new Error("Request failed");
}

// Fetch documents list
export async function fetchDocuments() {
  const res = await api.documents.get();
  if (res.error || !res.data || !("data" in res.data)) {
    throw extractError(res);
  }
  return res.data.data;
}

// Fetch single document details with counts
export async function fetchDocument(id: string) {
  const res = await api.documents({ id }).get();
  if (res.error || !res.data || "error" in res.data) {
    throw extractError(res);
  }
  return res.data;
}

// Fetch facts with client-side normalized pagination shape
export async function fetchFacts(params?: {
  documentId?: string;
  entityId?: string;
  limit?: string;
  page?: string;
  predicate?: string;
}) {
  const res = await api.facts.get({ query: params });
  if (res.error || !res.data || !("data" in res.data)) {
    throw extractError(res);
  }

  const page = Number(params?.page || 1);
  const limit = Number(params?.limit || 50);
  const total = (res.data as { total?: number }).total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    data: res.data.data,
    pagination: {
      limit,
      page,
      total,
      totalPages,
    },
  };
}

// Fetch single fact
export async function fetchFact(id: string) {
  const res = await api.facts({ id }).get();
  if (res.error || !res.data || "error" in res.data) {
    throw extractError(res);
  }
  return res.data;
}

// Fetch relationships for a given fact
export async function fetchFactRelationships(id: string) {
  const res = await api.facts({ id }).relationships.get();
  if (res.error || !res.data || !("data" in res.data)) {
    throw extractError(res);
  }
  return res.data.data;
}

// Fetch entities list (already returns pagination)
export async function fetchEntities(params?: {
  limit?: string;
  page?: string;
  search?: string;
}) {
  const res = await api.entities.get({ query: params });
  if (res.error || !res.data || !("data" in res.data)) {
    throw extractError(res);
  }
  return {
    data: res.data.data,
    pagination: res.data.pagination,
  };
}

// Fetch single entity with aliases and associated facts
export async function fetchEntity(
  id: string,
  params?: { limit?: string; page?: string }
) {
  const res = await api.entities({ id }).get({ query: params });
  if (res.error || !res.data || "error" in res.data) {
    throw extractError(res);
  }
  return res.data;
}

// Fetch relationships list
export async function fetchRelationships(params?: {
  limit?: string;
  page?: string;
  relationType?: string;
  type?: string;
}) {
  const res = await api.relationships.get({ query: params });
  if (res.error || !res.data || !("data" in res.data)) {
    throw extractError(res);
  }
  return {
    data: res.data.data,
    pagination: res.data.pagination,
  };
}

// Fetch single relationship
export async function fetchRelationship(id: string) {
  const res = await api.relationships({ id }).get();
  if (res.error || !res.data || "error" in res.data) {
    throw extractError(res);
  }
  return res.data;
}

// Upload PDF document helper with robust fallback
export async function uploadDocument(file: File) {
  try {
    const res = await api.documents.post({ file });
    if (res.data && "id" in res.data) {
      return res.data as {
        filename: string;
        id: string;
        status: string;
      };
    }
    if (res.error) {
      throw extractError(res);
    }
  } catch (err: unknown) {
    // If Eden treaty multipart encounters runtime issues, fallback to standard fetch
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`${apiUrl}/documents`, {
      body: formData,
      method: "POST",
    });
    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        errJson.error ||
          (err instanceof Error ? err.message : "Document upload failed"),
        { cause: err }
      );
    }
    return (await response.json()) as {
      filename: string;
      id: string;
      status: string;
    };
  }
  throw new Error("Document upload failed");
}
