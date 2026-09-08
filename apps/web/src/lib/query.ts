import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 10,
    },
  },
});

export const queryKeys = {
  health: ['health'] as const,
  facts: (filters?: Record<string, any>) => ['facts', filters] as const,
  fact: (id: string) => ['facts', id] as const,
  factRelationships: (id: string) => ['facts', id, 'relationships'] as const,
  entities: () => ['entities'] as const,
  entity: (id: string) => ['entities', id] as const,
  documents: () => ['documents'] as const,
};
