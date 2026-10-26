import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  UploadProgressPanel,
  type UploadProgressSession,
} from "@/features/dashboard/upload-progress-panel";

// Render the panel's content without a browser portal so its public labels and
// progress semantics can be checked independently of Radix positioning.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const session: UploadProgressSession = {
  items: [{ name: "report.zip", path: "report.zip", sizeBytes: 1024 }],
  ignoredFiles: 0,
  totalBytes: 1024,
  uploadedBytes: 1024,
  completedFiles: 0,
  completedFileIndexes: [],
  activeFileIndexes: [0],
  activeFileIndex: 0,
  activeFileUploadedBytes: 1024,
  startedAt: 0,
  updatedAt: 2000,
  status: "failed",
  error: "The upload could not be confirmed.",
};

function render(overrides: Partial<UploadProgressSession> = {}) {
  return renderToStaticMarkup(
    <UploadProgressPanel
      session={{ ...session, ...overrides }}
      onCancel={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

describe("upload progress panel", () => {
  it("keeps failed transfers below 100 percent and removes stale speed and ETA", () => {
    const html = render();
    expect(html).toContain('aria-valuenow="99"');
    expect(html).not.toContain('aria-valuenow="100"');
    expect(html).toContain("Stopped");
    expect(html).not.toContain("KB/s");
    expect(html).not.toContain("&lt; 1 sec");
    expect(html).toContain("Select the failed files again");
    expect(html).not.toContain("trying the folder again");
    expect(html).toContain("bg-destructive/15");
  });

  it("shows confirmation while data is accepted but the file is not published yet", () => {
    const html = render({ status: "uploading", error: null });
    expect(html).toContain("Confirming");
    expect(html).not.toContain('aria-valuenow="100"');
    expect(html).not.toContain("&lt; 1 sec");
  });

  it("marks the actual completed file when concurrent uploads finish out of order", () => {
    const html = render({
      items: ["first.txt", "second.txt", "third.txt"].map((name) => ({
        name,
        path: name,
        sizeBytes: 1024,
      })),
      totalBytes: 3072,
      completedFiles: 1,
      completedFileIndexes: [2],
      activeFileIndexes: [0, 1],
      status: "uploading",
      error: null,
    });
    expect(html).toMatch(
      /first\.txt<\/span><\/span><span[^>]*><span[^>]*>Uploading/,
    );
    expect(html).toMatch(
      /second\.txt<\/span><\/span><span[^>]*><span[^>]*>Uploading/,
    );
    expect(html).toMatch(
      /third\.txt<\/span><\/span><span[^>]*><span[^>]*>Uploaded/,
    );
  });

  it("does not spin on sibling files after an upload stops", () => {
    const html = render({
      items: ["first.txt", "second.txt"].map((name) => ({
        name,
        path: name,
        sizeBytes: 1024,
      })),
      activeFileIndexes: [0, 1],
    });
    expect(html).not.toContain("animate-spin");
    expect(html).toMatch(
      /second\.txt<\/span><\/span><span[^>]*><span[^>]*>Stopped/,
    );
  });
});
