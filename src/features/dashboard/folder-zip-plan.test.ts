import { describe, expect, it } from "vitest";

import {
  createFolderZipAdmission,
  FOLDER_ZIP_MAX_WORKERS,
  FOLDER_ZIP_MEMORY_BUDGET_BYTES,
  FOLDER_ZIP_TASK_BYTES,
  type FolderZipPlanEntry,
  folderZipTaskBytes,
  folderZipTaskCost,
  folderZipWorkerCount,
  planFolderZipTasks,
} from "@/features/dashboard/folder-zip-plan";

const file = (size: number, level = 1): FolderZipPlanEntry => ({ size, level });

describe("folder ZIP task plan", () => {
  it("groups small entries into batches bounded by bytes and entry count", () => {
    const entries = [file(40), file(0, 0), file(50), file(30), file(100)];
    expect(
      planFolderZipTasks(entries, { codec: "wasm", taskBytes: 100 }),
    ).toEqual([
      { kind: "batch", first: 0, count: 3, bytes: 90 },
      { kind: "batch", first: 3, count: 1, bytes: 30 },
      { kind: "batch", first: 4, count: 1, bytes: 100 },
    ]);
    expect(
      planFolderZipTasks(entries, {
        codec: "wasm",
        taskBytes: 1000,
        batchEntries: 2,
      }).map((task) => task.kind === "batch" && task.count),
    ).toEqual([2, 2, 1]);
  });

  it("cuts large entries into ranges that keep source order", () => {
    const entries = [file(10), file(250), file(10), file(10), file(201, 0)];
    expect(
      planFolderZipTasks([file(700, 0)], { codec: "wasm", taskBytes: 100 }),
    ).toEqual([
      { kind: "range", entry: 0, index: 0, start: 0, end: 300, final: false },
      { kind: "range", entry: 0, index: 1, start: 300, end: 600, final: false },
      { kind: "range", entry: 0, index: 2, start: 600, end: 700, final: true },
    ]);
    const plan = planFolderZipTasks(entries, { codec: "wasm", taskBytes: 100 });
    expect(plan).toEqual([
      { kind: "batch", first: 0, count: 1, bytes: 10 },
      { kind: "range", entry: 1, index: 0, start: 0, end: 100, final: false },
      { kind: "range", entry: 1, index: 1, start: 100, end: 200, final: false },
      { kind: "range", entry: 1, index: 2, start: 200, end: 250, final: true },
      // A batch never spans a large entry, so segments stay contiguous.
      { kind: "batch", first: 2, count: 2, bytes: 20 },
      // Stored ranges are only checksummed and are three times as large.
      { kind: "range", entry: 4, index: 0, start: 0, end: 201, final: true },
    ]);
    expect(plan.reduce((sum, task) => sum + folderZipTaskBytes(task), 0)).toBe(
      entries.reduce((sum, entry) => sum + entry.size, 0),
    );
  });

  it("streams large deflated entries when ranges cannot be deflated on their own", () => {
    const entries = [file(250), file(250, 0)];
    for (const codec of ["native", "none"] as const) {
      expect(
        planFolderZipTasks(entries, { codec, taskBytes: 100 }).map(
          (task) => task.kind,
        ),
      ).toEqual(["stream", "range"]);
    }
  });

  it("covers every entry exactly once", () => {
    const sizes = [0, 1, 99, 100, 101, 5, 5, 1000, 0, 0, 37, 250, 100];
    const entries = sizes.map((size, index) => file(size, index % 3 ? 1 : 0));
    const plan = planFolderZipTasks(entries, { codec: "wasm", taskBytes: 100 });
    const covered = entries.map(() => 0);
    for (const task of plan) {
      if (task.kind === "batch") {
        for (let index = 0; index < task.count; index++) {
          covered[task.first + index] += entries[task.first + index].size || 1;
        }
      } else if (task.kind === "range") {
        covered[task.entry] += task.end - task.start;
      }
    }
    expect(covered).toEqual(sizes.map((size) => size || 1));
  });

  it("charges tasks for the memory they hold while in flight", () => {
    const entries = [file(10), file(250), file(250, 0)];
    const [batch, deflated, , , stored] = planFolderZipTasks(entries, {
      codec: "wasm",
      taskBytes: 100,
    });
    expect(folderZipTaskCost(batch, entries, 100)).toBe(30);
    expect(folderZipTaskCost(deflated, entries, 100)).toBe(300);
    // A stored range is only read and checksummed.
    expect(folderZipTaskBytes(stored)).toBe(250);
    expect(folderZipTaskCost(stored, entries, 100)).toBe(250);
    const huge = [file(10 ** 9)];
    const [stream] = planFolderZipTasks(huge, {
      codec: "native",
      taskBytes: 100,
    });
    // A streamed entry holds a fixed window however large the file is.
    expect(stream.kind).toBe("stream");
    expect(folderZipTaskCost(stream, huge, 100)).toBe(300);
  });

  it("keeps the worst case of a full set of workers inside the budget", () => {
    for (const level of [0, 1]) {
      const entries = [file(FOLDER_ZIP_TASK_BYTES * 64, level)];
      const [range] = planFolderZipTasks(entries, { codec: "wasm" });
      expect(
        folderZipTaskCost(range, entries) * FOLDER_ZIP_MAX_WORKERS,
      ).toBeLessThanOrEqual(FOLDER_ZIP_MEMORY_BUDGET_BYTES);
    }
  });
});

describe("folder ZIP worker count", () => {
  it("follows the processor count up to the cap and the task count", () => {
    const count = (hardwareConcurrency: number | undefined, tasks = 1000) =>
      folderZipWorkerCount({ hardwareConcurrency, tasks });
    expect(count(8)).toBe(8);
    expect(count(64)).toBe(FOLDER_ZIP_MAX_WORKERS);
    expect(count(8, 3)).toBe(3);
    expect(count(undefined)).toBe(2);
    expect(count(0)).toBe(2);
  });

  it("runs inline when helpers would not add parallelism", () => {
    expect(folderZipWorkerCount({ hardwareConcurrency: 1, tasks: 50 })).toBe(0);
    expect(folderZipWorkerCount({ hardwareConcurrency: 16, tasks: 1 })).toBe(0);
    expect(folderZipWorkerCount({ hardwareConcurrency: 16, tasks: 0 })).toBe(0);
  });

  it("honours a valid requested cap", () => {
    const count = (requested: number) =>
      folderZipWorkerCount({ hardwareConcurrency: 12, requested, tasks: 100 });
    expect(count(4)).toBe(4);
    expect(count(1)).toBe(0);
    expect(count(64)).toBe(FOLDER_ZIP_MAX_WORKERS);
    expect(count(0)).toBe(12);
    expect(count(2.5)).toBe(12);
  });
});

describe("folder ZIP admission", () => {
  it("caps in-flight tasks by count", () => {
    const admission = createFolderZipAdmission({
      maxTasks: 2,
      budgetBytes: 1000,
    });
    expect(admission.tryAdmit(10)).toBe(true);
    expect(admission.tryAdmit(10)).toBe(true);
    expect(admission.tryAdmit(10)).toBe(false);
    admission.release(10);
    expect(admission.tryAdmit(10)).toBe(true);
    expect(admission.tasks).toBe(2);
    expect(admission.bytes).toBe(20);
  });

  it("caps in-flight tasks by the byte budget", () => {
    const admission = createFolderZipAdmission({
      maxTasks: 10,
      budgetBytes: 100,
    });
    expect(admission.tryAdmit(60)).toBe(true);
    expect(admission.tryAdmit(41)).toBe(false);
    expect(admission.tryAdmit(40)).toBe(true);
    expect(admission.tryAdmit(1)).toBe(false);
    admission.release(60);
    expect(admission.tryAdmit(60)).toBe(true);
    expect(admission.bytes).toBe(100);
  });

  it("sends a task larger than the whole budget through alone", () => {
    const admission = createFolderZipAdmission({
      maxTasks: 10,
      budgetBytes: 100,
    });
    expect(admission.tryAdmit(10)).toBe(true);
    expect(admission.tryAdmit(500)).toBe(false);
    admission.release(10);
    expect(admission.tryAdmit(500)).toBe(true);
    expect(admission.tryAdmit(1)).toBe(false);
    admission.release(500);
    expect(admission.tryAdmit(1)).toBe(true);
  });

  it("counts output that is waiting to be written against the budget", () => {
    const admission = createFolderZipAdmission({
      maxTasks: 10,
      budgetBytes: 100,
    });
    admission.hold(90);
    expect(admission.tryAdmit(20)).toBe(false);
    expect(admission.tasks).toBe(0);
    admission.unhold(30);
    expect(admission.tryAdmit(20)).toBe(true);
    admission.unhold(60);
    admission.release(20);
    expect(admission.bytes).toBe(0);
  });
});
