"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  parseRetentionDuration,
  type RetentionDuration,
  splitRetentionDuration,
} from "./trash-retention";

export function TrashRetentionInput({
  value,
  onChange,
  labelId,
}: {
  value: number;
  onChange(value: number): void;
  labelId: string;
}) {
  const [draft, setDraft] = useState(() => splitRetentionDuration(value));
  const [previousValue, setPreviousValue] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(false);
  if (previousValue !== value) {
    setPreviousValue(value);
    if (!dirty) setDraft(splitRetentionDuration(value));
  }
  function commit() {
    if (!dirty) return;
    const minutes = parseRetentionDuration(draft);
    setError(minutes === null);
    if (minutes === null) return;
    setDirty(false);
    setDraft(splitRetentionDuration(minutes));
    if (minutes !== value) onChange(minutes);
  }
  return (
    <div className="w-full sm:w-64">
      <fieldset
        aria-labelledby={labelId}
        className="grid grid-cols-3 gap-2"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      >
        {(["days", "hours", "minutes"] as const).map((unit) => (
          <div key={unit} className="space-y-1.5">
            <Label
              htmlFor={`${labelId}-${unit}`}
              className="text-xs text-muted-foreground"
            >
              {unit[0].toUpperCase() + unit.slice(1)}
            </Label>
            <Input
              id={`${labelId}-${unit}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={unit === "days" ? 365 : unit === "hours" ? 8760 : 525600}
              step={1}
              value={draft[unit]}
              aria-invalid={error}
              aria-describedby={error ? `${labelId}-error` : undefined}
              onChange={(event) => {
                setDirty(true);
                setError(false);
                setDraft((current: RetentionDuration) => ({
                  ...current,
                  [unit]: event.target.value,
                }));
              }}
            />
          </div>
        ))}
      </fieldset>
      {error ? (
        <p
          id={`${labelId}-error`}
          role="alert"
          className="mt-2 text-xs text-destructive"
        >
          Enter a duration from 1 minute to 365 days.
        </p>
      ) : null}
    </div>
  );
}
