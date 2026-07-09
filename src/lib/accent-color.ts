export type AccentColorPreset = {
  name: string;
  value: `#${string}`;
};

export const DEFAULT_ACCENT_COLOR = "#3088f0" as const;
export const ACCENT_COLOR_STORAGE_KEY = "aeralyth-accent-color";

export const ACCENT_COLOR_PRESETS: AccentColorPreset[] = [
  { name: "Aeralyth", value: DEFAULT_ACCENT_COLOR },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Emerald", value: "#10b981" },
  { name: "Rose", value: "#e11d48" },
  { name: "Amber", value: "#f59e0b" },
];

const hexColorPattern = /^#[0-9a-f]{6}$/i;

export function normalizeAccentColor(value: string | null | undefined) {
  const color = value?.trim();

  if (!color || !hexColorPattern.test(color)) {
    return null;
  }

  return color.toLowerCase();
}

export function getAccentForeground(color: string) {
  const normalizedColor = normalizeAccentColor(color) ?? DEFAULT_ACCENT_COLOR;
  const red = Number.parseInt(normalizedColor.slice(1, 3), 16);
  const green = Number.parseInt(normalizedColor.slice(3, 5), 16);
  const blue = Number.parseInt(normalizedColor.slice(5, 7), 16);
  const luminance =
    0.2126 * toLinearRgb(red) +
    0.7152 * toLinearRgb(green) +
    0.0722 * toLinearRgb(blue);
  const contrastWithDark = (luminance + 0.05) / 0.05;
  const contrastWithLight = 1.05 / (luminance + 0.05);

  return contrastWithDark >= contrastWithLight
    ? "oklch(0.141 0.005 285.823)"
    : "oklch(0.985 0 0)";
}

export function getAccentCssProperties(color: string) {
  const accentColor = normalizeAccentColor(color) ?? DEFAULT_ACCENT_COLOR;
  const foreground = getAccentForeground(accentColor);

  return {
    "--primary": accentColor,
    "--sidebar-primary": accentColor,
    "--ring": accentColor,
    "--primary-foreground": foreground,
    "--sidebar-primary-foreground": foreground,
  };
}

export function applyAccentColor(color: string) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  const scopedElements = document.querySelectorAll<HTMLElement>(
    "[data-accent-color-scope]",
  );
  const properties = getAccentCssProperties(color);

  [root, ...scopedElements].forEach((element) => {
    Object.entries(properties).forEach(([name, value]) => {
      element.style.setProperty(name, value);
    });
  });
}

function toLinearRgb(value: number) {
  const normalizedValue = value / 255;

  if (normalizedValue <= 0.03928) {
    return normalizedValue / 12.92;
  }

  return ((normalizedValue + 0.055) / 1.055) ** 2.4;
}
