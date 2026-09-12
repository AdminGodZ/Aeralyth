import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SnapshotRetry } from "./snapshot-retry";

let retry: SnapshotRetry;
let refresh = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  refresh = vi.fn();
  retry = new SnapshotRetry(refresh);
});
afterEach(() => {
  retry.setActive(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("does no work for a successfully loaded unchanged snapshot", () => {
  retry.setReady(true);
  retry.setActive(true);
  vi.advanceTimersByTime(60_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("retries failed route data with bounded backoff even when the cursor is unchanged", () => {
  retry.setReady(false);
  retry.setActive(true);
  vi.advanceTimersByTime(2_499);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledOnce();
  retry.setReady(false);
  vi.advanceTimersByTime(2_999);
  expect(refresh).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  retry.setReady(true);
  vi.advanceTimersByTime(60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("suspends failed-snapshot recovery while hidden and resumes without a burst", () => {
  retry.setReady(false);
  retry.setActive(true);
  retry.setActive(false);
  vi.advanceTimersByTime(60_000);
  expect(refresh).not.toHaveBeenCalled();
  retry.setActive(true);
  vi.advanceTimersByTime(2_500);
  expect(refresh).toHaveBeenCalledOnce();
});
