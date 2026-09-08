import { describe, expect, it } from "bun:test";
import { parsePagination } from "./pagination";

describe("parsePagination pure utility", () => {
  it("defaults to page 1 and limit 50 when query is empty or undefined", () => {
    expect(parsePagination()).toEqual({ limit: 50, offset: 0, page: 1 });
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0, page: 1 });
    expect(parsePagination(null)).toEqual({ limit: 50, offset: 0, page: 1 });
  });

  it("respects custom default options", () => {
    expect(parsePagination({}, { defaultLimit: 20, defaultPage: 1 })).toEqual({
      limit: 20,
      offset: 0,
      page: 1,
    });
  });

  it("parses valid numeric strings", () => {
    expect(parsePagination({ limit: "25", page: "3" })).toEqual({
      limit: 25,
      offset: 50,
      page: 3,
    });
  });

  it("parses raw numbers", () => {
    expect(parsePagination({ limit: 15, page: 2 })).toEqual({
      limit: 15,
      offset: 15,
      page: 2,
    });
  });

  it("clamps invalid or non-positive pages to default page", () => {
    expect(parsePagination({ page: "0" }).page).toBe(1);
    expect(parsePagination({ page: "-5" }).page).toBe(1);
    expect(parsePagination({ page: "not-a-number" }).page).toBe(1);
    expect(parsePagination({ page: Number.NaN }).page).toBe(1);
    expect(parsePagination({ page: Number.POSITIVE_INFINITY }).page).toBe(1);
  });

  it("clamps limit between minLimit and maxLimit", () => {
    // Upper bound default 100
    expect(parsePagination({ limit: "500" }).limit).toBe(100);
    expect(parsePagination({ limit: 999 }).limit).toBe(100);

    // Lower bound default 1
    expect(parsePagination({ limit: "0" }).limit).toBe(1);
    expect(parsePagination({ limit: "-10" }).limit).toBe(1);

    // Custom max/min limit
    expect(
      parsePagination({ limit: "50" }, { maxLimit: 30, minLimit: 5 }).limit
    ).toBe(30);
    expect(
      parsePagination({ limit: "2" }, { maxLimit: 30, minLimit: 5 }).limit
    ).toBe(5);
  });

  it("falls back to default limit on NaN/invalid limit string", () => {
    expect(parsePagination({ limit: "xyz" }).limit).toBe(50);
    expect(parsePagination({ limit: Number.NaN }).limit).toBe(50);
  });

  it("truncates fractional values to integers", () => {
    const result = parsePagination({ limit: "15.9", page: "2.7" });
    expect(result.page).toBe(2);
    expect(result.limit).toBe(15);
    expect(result.offset).toBe(15);
  });
});
