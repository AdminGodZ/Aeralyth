import { describe, expect, it } from "vitest";

import { getStorageOrigin } from "@/lib/storage-origin";

describe("getStorageOrigin", () => {
  it("returns nothing for local storage", () => {
    expect(getStorageOrigin(undefined, false)).toBeNull();
    expect(getStorageOrigin("", true)).toBeNull();
  });

  it("reduces the configured bucket URL to its origin", () => {
    expect(
      getStorageOrigin("https://bucket.storage.railway.app/path?x=1", false),
    ).toBe("https://bucket.storage.railway.app");
  });

  it("accepts plain http only in development", () => {
    expect(getStorageOrigin("http://localhost:9000", false)).toBeNull();
    expect(getStorageOrigin("http://localhost:9000", true)).toBe(
      "http://localhost:9000",
    );
  });

  it("rejects values that are not http(s) URLs", () => {
    expect(getStorageOrigin("not a url", true)).toBeNull();
    expect(getStorageOrigin("ftp://bucket.example", true)).toBeNull();
  });
});
