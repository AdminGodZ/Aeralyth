import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type DottedSurfaceProps = ComponentProps<"div">;

export function DottedSurface({ className, ...props }: DottedSurfaceProps) {
  return (
    <div
      className={cn(
        "dotted-surface pointer-events-none absolute inset-0 z-0",
        className,
      )}
      aria-hidden="true"
      {...props}
    />
  );
}
