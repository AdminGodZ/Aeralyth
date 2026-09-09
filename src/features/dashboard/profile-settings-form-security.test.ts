import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("profile settings form security", () => {
  it("sends CSRF in a header before the server reads multipart data", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "profile-settings-form.tsx"),
      "utf8",
    );
    const save = source
      .split("async function saveSettings(")[1]
      ?.split("return (")[0];
    const form = source.split('<form\n      action="/api/profile"')[1];

    expect(save).toContain('headers: { "x-csrf-token": csrfToken }');
    expect(form).toBeTruthy();
    expect(form?.indexOf('name="csrf_token"')).toBeLessThan(
      form?.indexOf('name="profile_image"') ?? -1,
    );
  });

  it("autosaves changed fields through one serialized queue", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "profile-settings-form.tsx"),
      "utf8",
    );

    expect(source).toContain("while (pendingUpdateRef.current)");
    expect(source).toContain("mergeSettingsUpdates(");
    expect(source).toContain("queueSettingsUpdate({ displayName: value })");
    expect(source).toContain("queueSettingsUpdate({ themePreference: value })");
    expect(source).toContain(
      "queueSettingsUpdate({ trashRetentionMinutes: normalizedValue })",
    );
    expect(source).toMatch(
      /formData\.append\(\s*"trash_retention_minutes",\s*String\(update\.trashRetentionMinutes\),?\s*\)/,
    );
    expect(source).toContain("onColorChange={onAccentColorChange}");
    expect(source).not.toContain("Save changes");
  });
});
