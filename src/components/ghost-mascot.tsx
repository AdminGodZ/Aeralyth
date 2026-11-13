import { cn } from "@/lib/utils";

/**
 * Aeralyth's mascot. It floats in place by default; `flying` leans it forward
 * and trails streaks behind it, for work in progress.
 */
export function GhostMascot({
  flying = false,
  className,
}: {
  flying?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox={flying ? "0 0 64 64" : "6 4 60 60"}
      aria-hidden="true"
      data-flying={flying || undefined}
      className={cn("ghost-mascot", className)}
    >
      {flying ? (
        <g className="ghost-mascot-streaks">
          <rect x="7" y="22" width="6" height="2.6" rx="1.3" />
          <rect x="2" y="29.5" width="10" height="2.6" rx="1.3" />
          <rect x="6" y="37" width="6" height="2.6" rx="1.3" />
        </g>
      ) : (
        <ellipse
          className="ghost-mascot-shadow"
          cx="36"
          cy="60.5"
          rx="10"
          ry="1.6"
        />
      )}
      <g className="ghost-mascot-body">
        <path d="M17 32C17 19.5 25.5 12 36 12s19 7.5 19 20v19q0 3-2.6 1.6L49 51q-3.2-2-6.4 0l-3.4 2.2q-3.2 2-6.4 0L29.4 51q-3.2-2-6.4 0l-3.4 1.6Q17 54 17 51Z" />
        <g className="ghost-mascot-face">
          <ellipse cx="30.5" cy="29" rx="2.7" ry="3.7" />
          <ellipse cx="41.5" cy="29" rx="2.7" ry="3.7" />
          <ellipse cx="36" cy="38.5" rx="2" ry="2.5" />
        </g>
      </g>
    </svg>
  );
}

/** The flying mascot beside a status message that trails moving dots. */
export function GhostLoader({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("ghost-loader", className)}>
      <GhostMascot flying className="size-7 shrink-0" />
      <span className="ghost-loader-text">
        <span className="min-w-0 truncate" role="status">
          {label}
        </span>
        <span className="ghost-loader-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </span>
    </div>
  );
}
