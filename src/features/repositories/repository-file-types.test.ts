import { describe, expect, it } from "vitest";

import {
  decodeRepositoryText,
  formatHexDump,
  getRepositoryFilePresentation,
  isProbablyText,
} from "@/features/repositories/repository-file-types";

describe("repository file presentation", () => {
  it("recognizes source files and special project filenames", () => {
    expect(getRepositoryFilePresentation("component.tsx", null)).toMatchObject({
      kind: "text",
      language: "tsx",
    });
    expect(getRepositoryFilePresentation("Dockerfile", null)).toMatchObject({
      kind: "text",
      language: "dockerfile",
    });
    expect(getRepositoryFilePresentation("README.md", null)).toMatchObject({
      kind: "markdown",
      language: "markdown",
    });
  });

  it("uses MIME types and extensions for rich browser previews", () => {
    expect(
      getRepositoryFilePresentation("asset.unknown", "image/png"),
    ).toMatchObject({ kind: "image" });
    expect(getRepositoryFilePresentation("manual.pdf", null)).toMatchObject({
      kind: "pdf",
    });
    expect(getRepositoryFilePresentation("report.docx", null)).toMatchObject({
      kind: "archive",
      label: "DOCX package",
    });
  });

  it("detects extensionless UTF-8 and UTF-16 text", () => {
    expect(isProbablyText(new TextEncoder().encode("hello\nworld"))).toBe(true);
    const utf16 = Uint8Array.from([0xff, 0xfe, 0x68, 0, 0x69, 0]);
    expect(isProbablyText(utf16)).toBe(true);
    expect(decodeRepositoryText(utf16)).toEqual({
      encoding: "UTF-16 LE",
      text: "hi",
    });
  });

  it("keeps binary data out of the text renderer and formats a hex view", () => {
    const binary = Uint8Array.from([0, 1, 2, 65, 66]);
    expect(isProbablyText(binary)).toBe(false);
    expect(formatHexDump(binary)).toContain("00 01 02 41 42");
    expect(formatHexDump(binary)).toContain("|...AB|");
  });
});
