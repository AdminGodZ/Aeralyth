import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FileSummaryMetrics } from "./file-summary-metrics";
import type { FileSummary } from "./summary-resource";

const summary: FileSummary = {
  totalFiles: 123,
  totalFolders: 7,
  activeFiles: 123,
  trashedFiles: 0,
  favoriteFiles: 4,
  sharedFiles: 2,
  usedBytes: 2048,
};

it.each([undefined, false, true])(
  "renders the tree-operation status only while pending is %s",
  (treeOperationPending) => {
    const html = renderToStaticMarkup(
      <FileSummaryMetrics
        initialSummary={{ ...summary, treeOperationPending }}
      />,
    );
    expect(html).toContain("xl:grid-cols-5");
    expect(html).toContain("123");
    expect(html).toContain("2.0 KB");
    expect(html.includes("Updating files…")).toBe(
      treeOperationPending === true,
    );
    expect(html.includes('role="status"')).toBe(treeOperationPending === true);
  },
);
