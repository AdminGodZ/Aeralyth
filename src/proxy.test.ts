import { describe, expect, it } from "vitest";

import { config } from "./proxy";

// Next.js anchors a matcher source to the whole pathname.
const source = new RegExp(`^${config.matcher[0].source}$`);
const runsProxy = (pathname: string) => source.test(pathname);

describe("security header proxy matcher", () => {
  it("covers every page, whatever its path ends with", () => {
    for (const pathname of [
      "/",
      "/login",
      "/files",
      "/s/token",
      "/s/x.png",
      "/invite/x.svg",
      "/missing.ico",
      "/api",
      "/apifoo",
    ]) {
      expect(runsProxy(pathname), pathname).toBe(true);
    }
  });

  it("skips the API, build output, workers and public images", () => {
    for (const pathname of [
      "/api/auth/me",
      "/_next/static/chunks/app.js",
      "/_next/image",
      "/workers/vault.worker.js",
      "/favicon.ico",
      "/aeralyth_logo.svg",
    ]) {
      expect(runsProxy(pathname), pathname).toBe(false);
    }
  });
});
