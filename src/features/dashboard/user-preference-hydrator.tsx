"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

import {
  ACCENT_COLOR_STORAGE_KEY,
  applyAccentColor,
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from "@/lib/accent-color";

type UserPreferenceHydratorProps = {
  accentColor: string;
  themePreference: "system" | "light" | "dark";
};

export function UserPreferenceHydrator({
  accentColor,
  themePreference,
}: UserPreferenceHydratorProps) {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(themePreference);
  }, [setTheme, themePreference]);

  useEffect(() => {
    const normalizedAccentColor =
      normalizeAccentColor(accentColor) ?? DEFAULT_ACCENT_COLOR;

    applyAccentColor(normalizedAccentColor);

    try {
      if (normalizedAccentColor === DEFAULT_ACCENT_COLOR) {
        window.localStorage.removeItem(ACCENT_COLOR_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          ACCENT_COLOR_STORAGE_KEY,
          normalizedAccentColor,
        );
      }
    } catch {
      return;
    }
  }, [accentColor]);

  return null;
}
