import { describe, expect, it } from "vitest";
import {
  parseRetentionDuration,
  splitRetentionDuration,
} from "./trash-retention";

describe("minute-precision trash retention", () => {
  it("supports one minute, a mixed duration, and one year", () => {
    for (const value of [1, 59, 60, 1440, 1567, 525600]) {
      expect(parseRetentionDuration(splitRetentionDuration(value))).toBe(value);
    }
    expect(
      parseRetentionDuration({ days: "1", hours: "2", minutes: "7" }),
    ).toBe(1567);
    expect(splitRetentionDuration(90)).toEqual({
      days: "0",
      hours: "1",
      minutes: "30",
    });
  });
  it("rejects empty, negative, fractional, and out-of-range durations", () => {
    for (const value of ["", "-1", "1.5", "1e3", "525601"]) {
      expect(
        parseRetentionDuration({ days: "0", hours: "0", minutes: value }),
      ).toBeNull();
    }
    expect(
      parseRetentionDuration({ days: "365", hours: "0", minutes: "1" }),
    ).toBeNull();
    expect(
      parseRetentionDuration({ days: "0", hours: "0", minutes: "0" }),
    ).toBeNull();
  });
});
