const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${BYTE_UNITS[unitIndex]}`;
}

/** Up to two uppercase initials from a username or display name. */
export function getInitials(name: string): string {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || "A";
}
