"use client";

import { ChevronDown, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import {
  ACCENT_COLOR_PRESETS,
  ACCENT_COLOR_STORAGE_KEY,
  DEFAULT_ACCENT_COLOR,
  applyAccentColor,
  normalizeAccentColor,
} from "@/lib/accent-color";

type AccentColorPreferenceProps = {
  initialColor?: string | null;
  inputName?: string;
};

export function AccentColorPreference({
  initialColor,
  inputName,
}: AccentColorPreferenceProps) {
  const normalizedInitialColor =
    normalizeAccentColor(initialColor) ?? DEFAULT_ACCENT_COLOR;
  const [accentColor, setAccentColor] = useState<string>(normalizedInitialColor);

  useEffect(() => {
    const nextColor =
      normalizeAccentColor(initialColor) ??
      readStoredAccentColor() ??
      DEFAULT_ACCENT_COLOR;

    setAccentColor(nextColor);
    applyAccentColor(nextColor);
    syncStoredAccentColor(nextColor);
  }, [initialColor]);

  function updateAccentColor(value: string) {
    const nextColor = normalizeAccentColor(value);

    if (!nextColor) {
      return;
    }

    setAccentColor(nextColor);
    applyAccentColor(nextColor);
    syncStoredAccentColor(nextColor);
  }

  function resetAccentColor() {
    setAccentColor(DEFAULT_ACCENT_COLOR);
    applyAccentColor(DEFAULT_ACCENT_COLOR);
    removeStoredAccentColor();
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      {inputName ? (
        <input type="hidden" name={inputName} value={accentColor} />
      ) : null}
      <ColorPicker
        value={accentColor as `#${string}`}
        type="hex"
        swatches={ACCENT_COLOR_PRESETS.map((preset) => preset.value)}
        hideDefaultSwatches
        align="end"
        onValueChange={(value) => updateAccentColor(value.hex)}
      >
        <Button type="button" variant="outline" className="gap-2">
          <span
            className="size-4 rounded-full border"
            style={{ backgroundColor: accentColor }}
            aria-hidden="true"
          />
          <span className="font-mono text-xs uppercase">{accentColor}</span>
          <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
        </Button>
      </ColorPicker>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={accentColor === DEFAULT_ACCENT_COLOR}
        onClick={resetAccentColor}
      >
        <RotateCcw className="size-3" aria-hidden="true" />
        Reset
      </Button>
    </div>
  );
}

function readStoredAccentColor() {
  try {
    return normalizeAccentColor(
      window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

function writeStoredAccentColor(color: string) {
  try {
    window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, color);
  } catch {
    return;
  }
}

function removeStoredAccentColor() {
  try {
    window.localStorage.removeItem(ACCENT_COLOR_STORAGE_KEY);
  } catch {
    return;
  }
}

function syncStoredAccentColor(color: string) {
  if (color === DEFAULT_ACCENT_COLOR) {
    removeStoredAccentColor();
    return;
  }

  writeStoredAccentColor(color);
}
