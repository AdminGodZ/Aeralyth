import { formatDistanceToNow } from "date-fns";

export function formatRepositoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "recently";
  }

  return formatDistanceToNow(date, { addSuffix: true });
}
