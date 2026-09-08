export interface PaginationQuery {
  limit?: number | string | null;
  page?: number | string | null;
}

export interface PaginationOptions {
  defaultLimit?: number;
  defaultPage?: number;
  maxLimit?: number;
  minLimit?: number;
}

export interface ParsedPagination {
  limit: number;
  offset: number;
  page: number;
}

export const parsePagination = (
  query?: PaginationQuery | null,
  options?: PaginationOptions
): ParsedPagination => {
  const defaultPage = options?.defaultPage ?? 1;
  const defaultLimit = options?.defaultLimit ?? 50;
  const maxLimit = options?.maxLimit ?? 100;
  const minLimit = options?.minLimit ?? 1;

  const rawPage =
    query?.page === undefined || query?.page === null
      ? defaultPage
      : Number(query.page);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1
      ? Math.floor(rawPage)
      : defaultPage;

  const rawLimit =
    query?.limit === undefined || query?.limit === null
      ? defaultLimit
      : Number(query.limit);
  const clampedLimit = Number.isFinite(rawLimit)
    ? Math.floor(rawLimit)
    : defaultLimit;
  const limit = Math.max(minLimit, Math.min(maxLimit, clampedLimit));

  const offset = (page - 1) * limit;

  return { limit, offset, page };
};
