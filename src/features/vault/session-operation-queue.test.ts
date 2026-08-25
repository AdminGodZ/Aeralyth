import { describe, expect, it } from "vitest";

import { SessionOperationQueue } from "@/features/vault/session-operation-queue";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve() {
      resolve?.();
    },
  };
}

describe("SessionOperationQueue", () => {
  it("serializes one session in request order while another session proceeds", async () => {
    const queue = new SessionOperationQueue();
    const firstGate = deferred();
    const events: string[] = [];

    const first = queue.run("session-a", async () => {
      events.push("a0:start");
      await firstGate.promise;
      events.push("a0:end");
      return 0;
    });
    const second = queue.run("session-a", async () => {
      events.push("a1");
      return 1;
    });
    const otherSession = queue.run("session-b", async () => {
      events.push("b0");
      return 2;
    });

    await otherSession;
    expect(events).toEqual(["a0:start", "b0"]);
    firstGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([0, 1]);
    expect(events).toEqual(["a0:start", "b0", "a0:end", "a1"]);
  });

  it("continues the session queue after a rejected operation", async () => {
    const queue = new SessionOperationQueue();
    const failed = queue.run("session-a", async () => {
      throw new Error("bad chunk");
    });
    const recovered = queue.run("session-a", async () => "next");

    await expect(failed).rejects.toThrow("bad chunk");
    await expect(recovered).resolves.toBe("next");
  });

  it("processes deliberately concurrent chunk indices deterministically", async () => {
    const queue = new SessionOperationQueue();
    let nextChunk = 0;
    const encrypt = (chunkIndex: number) =>
      queue.run("session-a", async () => {
        expect(chunkIndex).toBe(nextChunk);
        await Promise.resolve();
        nextChunk += 1;
        return chunkIndex;
      });

    await expect(
      Promise.all([encrypt(0), encrypt(1), encrypt(2), encrypt(3)]),
    ).resolves.toEqual([0, 1, 2, 3]);
    expect(nextChunk).toBe(4);
  });

  it("wipes plaintext when a lock removes a session behind queued work", async () => {
    const queue = new SessionOperationQueue();
    const activeOperation = deferred();
    const plaintext = new Uint8Array([11, 22, 33, 44]);
    let sessionActive = true;

    const first = queue.run("session-a", async () => {
      await activeOperation.promise;
    });
    const queued = queue.run("session-a", async () => {
      if (!sessionActive) {
        plaintext.fill(0);
        throw new Error("encryption session is unavailable");
      }
    });

    sessionActive = false;
    activeOperation.resolve();

    await first;
    await expect(queued).rejects.toThrow("encryption session is unavailable");
    expect(plaintext).toEqual(new Uint8Array(4));
  });
});
