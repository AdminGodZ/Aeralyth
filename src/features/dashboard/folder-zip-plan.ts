// Scheduling policy for the folder ZIP worker: how sources are cut into tasks,
// how many tasks run at once, and how much memory in-flight tasks may hold.
// Pure functions only, so the policy can be tested without workers.

/**
 * Upper bound of the source bytes one task reads into memory. Files up to this
 * size are grouped into batches; larger files are cut into ranges of this size.
 */
export const FOLDER_ZIP_TASK_BYTES = 2 * 1024 * 1024;
/**
 * Caps a batch of very small files, whose cost is the per-file read rather
 * than the bytes, so that progress keeps moving.
 */
export const FOLDER_ZIP_BATCH_ENTRIES = 128;
/**
 * Ranges of a stored entry are only checksummed, which holds a third of the
 * memory of a deflated range, so they are this many times larger.
 */
const STORED_RANGE_TASKS = 3;
export const FOLDER_ZIP_MAX_WORKERS = 16;
/**
 * Upper bound of the memory held by tasks that are in flight and by finished
 * output that is not written out yet. See `folderZipTaskCost` for what a task
 * is charged.
 */
export const FOLDER_ZIP_MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
/**
 * Stored entries at least this large are referenced from the archive instead
 * of copied into it.
 */
export const FOLDER_ZIP_REFERENCE_BYTES = 1024 * 1024;

/**
 * wasm: synchronous zlib, any range of a file can be deflated on its own.
 * native: CompressionStream, which can only deflate a file front to back.
 * none: no deflate at all, every entry is stored.
 */
export type FolderZipCodec = "wasm" | "native" | "none";

export type FolderZipPlanEntry = {
  /** Source bytes; zero for directories. */
  size: number;
  /** Deflate level, or zero to store the entry. */
  level: number;
};

export type FolderZipPlanTask =
  | {
      /** Consecutive entries that are read, compressed and framed together. */
      kind: "batch";
      first: number;
      count: number;
      bytes: number;
    }
  | {
      /**
       * One range of a large entry. Ranges of a deflated entry are compressed
       * independently and concatenate into one deflate stream; ranges of a
       * stored entry are only checksummed.
       */
      kind: "range";
      entry: number;
      index: number;
      start: number;
      end: number;
      final: boolean;
    }
  | {
      /** A large entry deflated front to back by the native codec. */
      kind: "stream";
      entry: number;
      bytes: number;
    };

export type FolderZipPlanOptions = {
  codec: FolderZipCodec;
  taskBytes?: number;
  batchEntries?: number;
};

/** Cuts the entries, in archive order, into independent tasks. */
export function planFolderZipTasks(
  entries: readonly FolderZipPlanEntry[],
  {
    codec,
    taskBytes = FOLDER_ZIP_TASK_BYTES,
    batchEntries = FOLDER_ZIP_BATCH_ENTRIES,
  }: FolderZipPlanOptions,
): FolderZipPlanTask[] {
  const tasks: FolderZipPlanTask[] = [];
  let batch: Extract<FolderZipPlanTask, { kind: "batch" }> | null = null;

  entries.forEach((entry, index) => {
    if (entry.size <= taskBytes) {
      if (
        !batch ||
        batch.count >= batchEntries ||
        batch.bytes + entry.size > taskBytes
      ) {
        batch = { kind: "batch", first: index, count: 0, bytes: 0 };
        tasks.push(batch);
      }
      batch.count += 1;
      batch.bytes += entry.size;
      return;
    }

    batch = null;
    if (entry.level > 0 && codec !== "wasm") {
      tasks.push({ kind: "stream", entry: index, bytes: entry.size });
      return;
    }
    const rangeBytes =
      entry.level > 0 ? taskBytes : rangeBytesOfStored(taskBytes);
    for (let start = 0, range = 0; start < entry.size; range++) {
      const end = Math.min(entry.size, start + rangeBytes);
      tasks.push({
        kind: "range",
        entry: index,
        index: range,
        start,
        end,
        final: end === entry.size,
      });
      start = end;
    }
  });
  return tasks;
}

/** Source bytes a task consumes, which is also its share of the progress. */
export function folderZipTaskBytes(task: FolderZipPlanTask): number {
  return task.kind === "range" ? task.end - task.start : task.bytes;
}

/**
 * Worst-case memory a task holds while it is in flight: the source bytes it
 * read, plus, when it produces output, the codec's output buffer and the copy
 * that is handed back. A streamed entry holds a fixed window whatever its size.
 */
export function folderZipTaskCost(
  task: FolderZipPlanTask,
  entries: readonly FolderZipPlanEntry[],
  taskBytes = FOLDER_ZIP_TASK_BYTES,
): number {
  if (task.kind === "stream") return 3 * taskBytes;
  if (task.kind === "batch") return 3 * task.bytes;
  const bytes = task.end - task.start;
  return entries[task.entry].level > 0 ? 3 * bytes : bytes;
}

/**
 * Number of helper workers to start. Zero means the tasks run inline in the
 * coordinating worker, which is also the fallback when helpers cannot start.
 */
export function folderZipWorkerCount({
  hardwareConcurrency,
  requested,
  tasks,
}: {
  hardwareConcurrency: number | undefined;
  requested?: number;
  tasks: number;
}): number {
  const available =
    positiveInteger(requested) ?? positiveInteger(hardwareConcurrency) ?? 2;
  const count = Math.min(available, FOLDER_ZIP_MAX_WORKERS, tasks);
  // A single helper only adds a thread hop over running inline.
  return count < 2 ? 0 : count;
}

export type FolderZipAdmission = {
  /** Reserves room for a task, or returns false when it has to wait. */
  tryAdmit(cost: number): boolean;
  release(cost: number): void;
  /** Charges memory that is not tied to a task, such as unwritten output. */
  hold(bytes: number): void;
  unhold(bytes: number): void;
  readonly tasks: number;
  readonly bytes: number;
};

/**
 * Bounds in-flight work by task count and by a byte budget. A task that costs
 * more than the whole budget is still admitted, but only when nothing else is
 * in flight or held.
 */
export function createFolderZipAdmission({
  maxTasks,
  budgetBytes = FOLDER_ZIP_MEMORY_BUDGET_BYTES,
}: {
  maxTasks: number;
  budgetBytes?: number;
}): FolderZipAdmission {
  let tasks = 0;
  let bytes = 0;
  return {
    tryAdmit(cost) {
      if (tasks >= maxTasks) return false;
      if (bytes > 0 && bytes + cost > budgetBytes) return false;
      tasks += 1;
      bytes += cost;
      return true;
    },
    release(cost) {
      tasks -= 1;
      bytes -= cost;
    },
    hold(held) {
      bytes += held;
    },
    unhold(held) {
      bytes -= held;
    },
    get tasks() {
      return tasks;
    },
    get bytes() {
      return bytes;
    },
  };
}

function rangeBytesOfStored(taskBytes: number): number {
  return STORED_RANGE_TASKS * taskBytes;
}

function positiveInteger(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
