import { describe, expect, it } from "vitest";

import { filesFromClipboard } from "@/features/dashboard/clipboard-upload";

const now = new Date(2026, 10, 19, 9, 4, 7);

function fileItem(file: File, isDirectory = false) {
  return {
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory }),
  };
}

describe("filesFromClipboard", () => {
  it("returns nothing for a paste without files", () => {
    expect(filesFromClipboard(null)).toEqual({ files: [], skippedFolders: 0 });
    expect(
      filesFromClipboard({
        items: [{ kind: "string", getAsFile: () => null }],
        files: [],
      }),
    ).toEqual({ files: [], skippedFolders: 0 });
  });

  it("keeps copied files as they are", () => {
    const report = new File(["a"], "report.pdf", {
      type: "application/pdf",
      lastModified: now.getTime(),
    });
    const photo = new File(["b"], "image.png", {
      type: "image/png",
      lastModified: now.getTime() - 86_400_000,
    });
    const { files } = filesFromClipboard(
      { items: [fileItem(report), fileItem(photo)] },
      now,
    );
    expect(files).toEqual([report, photo]);
  });

  it("names a pasted screenshot after the paste time", () => {
    const bitmap = new File(["c"], "image.png", {
      type: "image/png",
      lastModified: now.getTime(),
    });
    const { files } = filesFromClipboard({ items: [fileItem(bitmap)] }, now);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("Pasted image 2026-11-19 at 09.04.07.png");
    expect(files[0].type).toBe("image/png");
    expect(files[0].size).toBe(1);
  });

  it("numbers several pasted bitmaps", () => {
    const first = new File(["d"], "image.png", {
      type: "image/png",
      lastModified: now.getTime(),
    });
    const second = new File(["e"], "image.jpeg", {
      type: "image/jpeg",
      lastModified: now.getTime(),
    });
    const { files } = filesFromClipboard(
      { items: [fileItem(first), fileItem(second)] },
      now,
    );
    expect(files.map((file) => file.name)).toEqual([
      "Pasted image 2026-11-19 at 09.04.07 (1).png",
      "Pasted image 2026-11-19 at 09.04.07 (2).jpeg",
    ]);
  });

  it("counts folders instead of uploading them", () => {
    const folder = new File([], "Photos");
    const note = new File(["f"], "note.txt", { type: "text/plain" });
    expect(
      filesFromClipboard(
        { items: [fileItem(folder, true), fileItem(note)] },
        now,
      ),
    ).toEqual({ files: [note], skippedFolders: 1 });
  });

  it("falls back to the file list", () => {
    const note = new File(["g"], "note.txt", { type: "text/plain" });
    expect(filesFromClipboard({ items: [], files: [note] }, now)).toEqual({
      files: [note],
      skippedFolders: 0,
    });
  });
});
