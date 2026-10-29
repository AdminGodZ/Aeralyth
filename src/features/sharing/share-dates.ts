const shareDateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatShareDateTime(value: string): string {
  return `${shareDateTimeFormatter.format(new Date(value))} UTC`;
}

export function formatShareExpiration(value: string | null): string {
  return value ? formatShareDateTime(value) : "Never";
}
