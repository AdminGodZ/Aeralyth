import { describe, expect, it } from "vitest";

import type { ExistingUploadNode } from "@/features/dashboard/folder-upload-conflicts";
import { getEncryptedReplacementVersion } from "@/features/vault/encrypted-upload";

const encryptedFile: ExistingUploadNode = {
  id: "fil_existing",
  name: "main.ts",
  entryType: "file",
  e2eeState: "encrypted",
  generationNumber: 4,
  recordVersion: 7,
  recordHash: "record-hash",
};

describe("getEncryptedReplacementVersion", () => {
  it("binds replacement uploads to the existing encrypted record", () => {
    expect(getEncryptedReplacementVersion(encryptedFile)).toEqual({
      nodeId: "fil_existing",
      generationNumber: 4,
      recordVersion: 7,
      recordHash: "record-hash",
    });
  });

  it("rejects legacy or incomplete replacement records", () => {
    expect(() =>
      getEncryptedReplacementVersion({
        ...encryptedFile,
        e2eeState: "legacy",
      }),
    ).toThrow("cannot be replaced until its encrypted record is ready");
    expect(() =>
      getEncryptedReplacementVersion({
        ...encryptedFile,
        recordHash: undefined,
      }),
    ).toThrow("cannot be replaced until its encrypted record is ready");
  });
});
