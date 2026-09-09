export const MIN_TRASH_RETENTION_MINUTES = 1;
export const MAX_TRASH_RETENTION_MINUTES = 365 * 24 * 60;
export const DEFAULT_TRASH_RETENTION_MINUTES = 30 * 24 * 60;

export type RetentionDuration = {
  days: string;
  hours: string;
  minutes: string;
};

export function validTrashRetentionMinutes(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_TRASH_RETENTION_MINUTES &&
    value <= MAX_TRASH_RETENTION_MINUTES
  );
}

export function normalizeTrashRetentionMinutes(value: number): number {
  return validTrashRetentionMinutes(value)
    ? value
    : DEFAULT_TRASH_RETENTION_MINUTES;
}

export function splitRetentionDuration(total: number): RetentionDuration {
  return {
    days: String(Math.floor(total / 1440)),
    hours: String(Math.floor((total % 1440) / 60)),
    minutes: String(total % 60),
  };
}

export function parseRetentionDuration(
  value: RetentionDuration,
): number | null {
  const parts = [value.days, value.hours, value.minutes];
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const total =
    Number(value.days) * 1440 +
    Number(value.hours) * 60 +
    Number(value.minutes);
  return validTrashRetentionMinutes(total) ? total : null;
}
