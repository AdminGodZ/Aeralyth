"use client";

import { ChevronDown, RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import {
  ACCENT_COLOR_PRESETS,
  applyAccentColor,
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from "@/lib/accent-color";

type AccentColorPreferenceProps = {
  initialColor?: string | null;
  inputName?: string;
  labelId?: string;
};

export function AccentColorPreference({
  initialColor,
  inputName,
  labelId,
}: AccentColorPreferenceProps) {
  const valueId = useId();
  const normalizedInitialColor =
    normalizeAccentColor(initialColor) ?? DEFAULT_ACCENT_COLOR;
  const [accentColor, setAccentColor] = useState<string>(
    normalizedInitialColor,
  );

  useEffect(() => {
    const nextColor =
      normalizeAccentColor(initialColor) ?? DEFAULT_ACCENT_COLOR;

    setAccentColor(nextColor);
    applyAccentColor(nextColor);
  }, [initialColor]);

  function updateAccentColor(value: string) {
    const nextColor = normalizeAccentColor(value);

    if (!nextColor) {
      return;
    }

    setAccentColor(nextColor);
    applyAccentColor(nextColor);
  }

  function resetAccentColor() {
    setAccentColor(DEFAULT_ACCENT_COLOR);
    applyAccentColor(DEFAULT_ACCENT_COLOR);
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
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
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          aria-labelledby={labelId ? `${labelId} ${valueId}` : undefined}
          aria-label={labelId ? undefined : `Accent color ${accentColor}`}
        >
          <span
            className="size-4 rounded-full border"
            style={{ backgroundColor: accentColor }}
            aria-hidden="true"
          />
          <span id={valueId} className="font-mono text-xs uppercase">
            {accentColor}
          </span>
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
