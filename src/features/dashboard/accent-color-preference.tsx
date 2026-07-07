"use client";

import { ChevronDown, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import {
  ACCENT_COLOR_PRESETS,
  ACCENT_COLOR_STORAGE_KEY,
  DEFAULT_ACCENT_COLOR,
  getAccentForeground,
  normalizeAccentColor,
} from "@/lib/accent-color";

export function AccentColorPreference() {
  const [accentColor, setAccentColor] = useState<string>(DEFAULT_ACCENT_COLOR);

  useEffect(() => {
    const storedColor = readStoredAccentColor();
    const nextColor = storedColor ?? DEFAULT_ACCENT_COLOR;

    setAccentColor(nextColor);
    applyAccentColor(nextColor);
  }, []);

  function updateAccentColor(value: string) {
    const nextColor = normalizeAccentColor(value);

    if (!nextColor) {
      return;
    }

    setAccentColor(nextColor);
    applyAccentColor(nextColor);

    if (nextColor === DEFAULT_ACCENT_COLOR) {
      removeStoredAccentColor();
      return;
    }

    writeStoredAccentColor(nextColor);
  }

  function resetAccentColor() {
    setAccentColor(DEFAULT_ACCENT_COLOR);
    applyAccentColor(DEFAULT_ACCENT_COLOR);
    removeStoredAccentColor();
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
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

function applyAccentColor(color: string) {
  const foreground = getAccentForeground(color);
  const root = document.documentElement;

  root.style.setProperty("--primary", color);
  root.style.setProperty("--sidebar-primary", color);
  root.style.setProperty("--ring", color);
  root.style.setProperty("--primary-foreground", foreground);
  root.style.setProperty("--sidebar-primary-foreground", foreground);
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
