import { describe, expect, it } from "vitest";
import { planMatrixColumns } from "./storage-matrix";

describe("storage matrix columns", () => {
  it("keeps a sliver of usage visible instead of rounding it away", () => {
    expect(
      planMatrixColumns([{ key: "used", value: 13 }], 10_000, 180),
    ).toEqual([{ key: "used", start: 0, end: 2 }]);
  });

  it("fills every column when the segments are the whole bar", () => {
    expect(
      planMatrixColumns(
        [
          { key: "own", value: 1 },
          { key: "rest", value: 2 },
        ],
        3,
        100,
      ),
    ).toEqual([
      { key: "own", start: 0, end: 33 },
      { key: "rest", start: 33, end: 100 },
    ]);
  });

  it("leaves a column of free space on a bar that is almost full", () => {
    expect(
      planMatrixColumns([{ key: "used", value: 9_999 }], 10_000, 100),
    ).toEqual([{ key: "used", start: 0, end: 99 }]);
  });

  it("never spills past the bar when usage exceeds the total", () => {
    expect(planMatrixColumns([{ key: "used", value: 12 }], 10, 100)).toEqual([
      { key: "used", start: 0, end: 100 },
    ]);
  });

  it("skips empty segments and draws nothing without a capacity", () => {
    expect(
      planMatrixColumns(
        [
          { key: "own", value: 0 },
          { key: "rest", value: 5 },
        ],
        5,
        40,
      ),
    ).toEqual([{ key: "rest", start: 0, end: 40 }]);
    expect(planMatrixColumns([], 0, 40)).toEqual([]);
    expect(planMatrixColumns([{ key: "used", value: 1 }], 2, 0)).toEqual([]);
  });
});
