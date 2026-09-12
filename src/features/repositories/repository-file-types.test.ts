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

  it("omits incomplete UTF-8 and UTF-16 characters only for partial data", () => {
    const utf8 = Uint8Array.of(65, 0xf0, 0x9f, 0x98);
    expect(decodeRepositoryText(utf8, true).text).toBe("A");
    expect(decodeRepositoryText(utf8).text).toBe("A\ufffd");
    const utf16le = Uint8Array.of(0xff, 0xfe, 65, 0, 0x3d, 0xd8, 0);
    expect(decodeRepositoryText(utf16le, true).text).toBe("A");
    const utf16be = Uint8Array.of(0xfe, 0xff, 0, 65, 0xd8, 0x3d, 0);
    expect(decodeRepositoryText(utf16be, true).text).toBe("A");
    expect(decodeRepositoryText(Uint8Array.of(65, 0xff, 66), true).text).toBe(
      "A\ufffdB",
    );
  });

  it("detects UTF-8 text when its sniffing sample ends inside a character", () => {
    const text = new Uint8Array(9000).fill(65);
    text.set([0xf0, 0x9f, 0x98, 0x80], 8191);
    expect(isProbablyText(text)).toBe(true);
    expect(isProbablyText(Uint8Array.of(65, 0xf0, 0x9f), true)).toBe(true);
    expect(isProbablyText(Uint8Array.of(65, 0xff, 66), true)).toBe(false);
  });
});
