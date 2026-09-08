import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 10,
    },
  },
});

export const queryKeys = {
  documents: () => ["documents"] as const,
  entities: () => ["entities"] as const,
  entity: (id: string) => ["entities", id] as const,
  fact: (id: string) => ["facts", id] as const,
  factRelationships: (id: string) => ["facts", id, "relationships"] as const,
  facts: (filters?: Record<string, unknown>) => ["facts", filters] as const,
  health: ["health"] as const,
};
