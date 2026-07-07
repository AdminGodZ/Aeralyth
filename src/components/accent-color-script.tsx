import {
  ACCENT_COLOR_STORAGE_KEY,
  DEFAULT_ACCENT_COLOR,
} from "@/lib/accent-color";

const accentColorScript = `
(function () {
  try {
    var storageKey = ${JSON.stringify(ACCENT_COLOR_STORAGE_KEY)};
    var fallbackColor = ${JSON.stringify(DEFAULT_ACCENT_COLOR)};
    var pattern = /^#[0-9a-f]{6}$/i;
    var color = localStorage.getItem(storageKey);

    if (!pattern.test(color || "")) {
      color = fallbackColor;
    }

    color = color.toLowerCase();

    function toLinearRgb(value) {
      var normalizedValue = value / 255;

      if (normalizedValue <= 0.03928) {
        return normalizedValue / 12.92;
      }

      return Math.pow((normalizedValue + 0.055) / 1.055, 2.4);
    }

    var red = parseInt(color.slice(1, 3), 16);
    var green = parseInt(color.slice(3, 5), 16);
    var blue = parseInt(color.slice(5, 7), 16);
    var luminance =
      0.2126 * toLinearRgb(red) +
      0.7152 * toLinearRgb(green) +
      0.0722 * toLinearRgb(blue);
    var contrastWithDark = (luminance + 0.05) / 0.05;
    var contrastWithLight = 1.05 / (luminance + 0.05);
    var foreground =
      contrastWithDark >= contrastWithLight
        ? "oklch(0.141 0.005 285.823)"
        : "oklch(0.985 0 0)";
    var root = document.documentElement;

    root.style.setProperty("--primary", color);
    root.style.setProperty("--sidebar-primary", color);
    root.style.setProperty("--ring", color);
    root.style.setProperty("--primary-foreground", foreground);
    root.style.setProperty("--sidebar-primary-foreground", foreground);
  } catch (_) {}
})();
`;

export function AccentColorScript() {
  return <script dangerouslySetInnerHTML={{ __html: accentColorScript }} />;
}
