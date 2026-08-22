import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ShareLinkDialog } from "@/features/sharing/share-link-dialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("ShareLinkDialog rendering", () => {
  it("renders safely while closed after its controller extraction", () => {
    expect(
      renderToStaticMarkup(
        <ShareLinkDialog
          open={false}
          onOpenChange={vi.fn()}
          itemId="file-test"
          itemName="report.pdf"
          itemType="file"
          initiallyShared={false}
          csrfToken="test-csrf"
        />,
      ),
    ).toBe("");
  });
});
