import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VaultProvider } from "@/features/vault/vault-provider";

describe("VaultProvider rendering", () => {
  it("preserves its children when encrypted storage is disabled", () => {
    const markup = renderToStaticMarkup(
      <VaultProvider
        csrfToken="test-csrf"
        e2eeMode="off"
        vaultConfigured={false}
        autoLockMinutes={15}
      >
        <p>dashboard content</p>
      </VaultProvider>,
    );

    expect(markup).toContain("dashboard content");
  });
});
